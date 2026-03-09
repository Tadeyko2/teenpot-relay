// TeenPot Cloud Relay Server
// Bridges ESP32 devices and Flutter apps over the internet.
//
// Paths:
//   ws /device/{deviceId}  — ESP32 connects here (device → relay)
//   ws /app/{deviceId}     — Flutter app connects here (app → relay)
//   GET /api/devices       — list online devices (REST)
//   GET /health            — health check for Fly.io
//
// Messages flow bidirectionally:
//   device → relay → all apps watching that device
//   app    → relay → the device

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// In-memory registry (no database needed)
// deviceId → { ws, connectedAt, lastMessageAt }
const devices = new Map();
// deviceId → Set<ws>
const appClients = new Map();

// Create HTTP server
const httpServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // REST: list online devices
  if (pathname === '/api/devices') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    const list = [];
    for (const [id, info] of devices) {
      list.push({
        id,
        online: true,
        connectedAt: info.connectedAt,
        lastSeen: info.lastMessageAt,
        appCount: (appClients.get(id) || new Set()).size,
      });
    }
    res.end(JSON.stringify(list));
    return;
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TeenPot Relay v1.0.0');
});

// WebSocket server (noServer mode — we handle upgrade routing ourselves)
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const parts = pathname.split('/').filter(Boolean);

  // /device/{deviceId}
  if (parts.length === 2 && parts[0] === 'device') {
    const deviceId = parts[1].toUpperCase();
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleDeviceConnection(ws, deviceId);
    });
    return;
  }

  // /app/{deviceId}
  if (parts.length === 2 && parts[0] === 'app') {
    const deviceId = parts[1].toUpperCase();
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleAppConnection(ws, deviceId);
    });
    return;
  }

  // Unknown path — reject
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// Handle ESP32 device connection
function handleDeviceConnection(ws, deviceId) {
  const now = new Date().toISOString();
  console.log(`[device] ${deviceId} connected`);

  // If there's already a connection with this ID (device reboot), close old one
  const existing = devices.get(deviceId);
  if (existing) {
    console.log(`[device] ${deviceId} replacing existing connection`);
    try { existing.ws.close(1000, 'replaced'); } catch (_) {}
  }

  devices.set(deviceId, {
    ws,
    connectedAt: now,
    lastMessageAt: now,
  });

  // Notify any watching apps that device is online
  const watchers = appClients.get(deviceId);
  if (watchers) {
    const statusMsg = JSON.stringify({ t: 'device_status', online: true });
    for (const appWs of watchers) {
      safeSend(appWs, statusMsg);
    }
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Forward device messages to all watching apps
  ws.on('message', (data) => {
    const info = devices.get(deviceId);
    if (info) info.lastMessageAt = new Date().toISOString();

    const watchers = appClients.get(deviceId);
    if (!watchers || watchers.size === 0) return;

    const msg = data.toString();
    for (const appWs of watchers) {
      safeSend(appWs, msg);
    }
  });

  ws.on('close', () => {
    console.log(`[device] ${deviceId} disconnected`);
    // Only remove if this is still the current connection
    const current = devices.get(deviceId);
    if (current && current.ws === ws) {
      devices.delete(deviceId);
    }

    // Notify apps
    const watchers = appClients.get(deviceId);
    if (watchers) {
      const offlineMsg = JSON.stringify({ t: 'device_offline' });
      for (const appWs of watchers) {
        safeSend(appWs, offlineMsg);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[device] ${deviceId} error:`, err.message);
  });
}

// Handle Flutter app connection
function handleAppConnection(ws, deviceId) {
  console.log(`[app] connected to ${deviceId}`);

  // Add to watchers set
  if (!appClients.has(deviceId)) {
    appClients.set(deviceId, new Set());
  }
  appClients.get(deviceId).add(ws);

  // Send immediate device status
  const device = devices.get(deviceId);
  const statusMsg = JSON.stringify({
    t: 'device_status',
    online: !!device,
    deviceId,
  });
  safeSend(ws, statusMsg);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Forward app messages to the device (future: remote commands)
  ws.on('message', (data) => {
    const device = devices.get(deviceId);
    if (device) {
      safeSend(device.ws, data.toString());
    }
  });

  ws.on('close', () => {
    console.log(`[app] disconnected from ${deviceId}`);
    const watchers = appClients.get(deviceId);
    if (watchers) {
      watchers.delete(ws);
      if (watchers.size === 0) {
        appClients.delete(deviceId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[app] ${deviceId} error:`, err.message);
  });
}

// Safe send — catches errors on dead sockets
function safeSend(ws, msg) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  } catch (_) {}
}

// Heartbeat: ping every 30s, terminate dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[heartbeat] terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`[relay] TeenPot relay server listening on port ${PORT}`);
  console.log(`[relay] Device URL:  ws://localhost:${PORT}/device/{deviceId}`);
  console.log(`[relay] App URL:     ws://localhost:${PORT}/app/{deviceId}`);
  console.log(`[relay] Devices API: http://localhost:${PORT}/api/devices`);
});
