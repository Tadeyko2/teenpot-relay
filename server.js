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
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Static file serving — Flutter web build
const STATIC_DIR = process.env.STATIC_DIR
  || path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.sf2':  'application/octet-stream',
};

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

  // Debug: detailed device connection state
  if (pathname === '/api/debug') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    const info = {};
    for (const [id, d] of devices) {
      const ws = d.ws;
      info[id] = {
        online: true,
        readyState: ws.readyState,
        bufferedAmount: ws.bufferedAmount || 0,
        connectedAt: d.connectedAt,
        lastMessageAt: d.lastMessageAt,
        appCount: (appClients.get(id) || new Set()).size,
      };
    }
    res.end(JSON.stringify(info, null, 2));
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

  // Static files — serve Flutter web build
  let urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(STATIC_DIR, urlPath);
  const ext = path.extname(filePath).toLowerCase();

  // Security: no path traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback: serve index.html for unknown routes
      const indexPath = path.join(STATIC_DIR, 'index.html');
      fs.readFile(indexPath, (e2, data) => {
        if (e2) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('TeenPot Relay v1.0.0');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// WebSocket server (noServer mode — we handle upgrade routing ourselves)
// 16 MB max payload to support SF2 upload chunks (8KB each) + control messages
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

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

  // Forward device messages to all watching apps (text + binary)
  ws.on('message', (data, isBinary) => {
    const info = devices.get(deviceId);
    if (info) info.lastMessageAt = new Date().toISOString();

    // Log SF2-related messages
    if (!isBinary) {
      const str = data.toString();
      if (str.includes('sf2') || str.includes('system_info') || str.includes('upload')) {
        console.log(`[dev→app] ${deviceId} text: ${str.slice(0, 200)}`);
      }
    }

    const watchers = appClients.get(deviceId);
    if (!watchers || watchers.size === 0) return;

    for (const appWs of watchers) {
      safeSend(appWs, data, isBinary);
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

  // Forward app messages to the device (text commands + binary SF2 chunks)
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      console.log(`[app→dev] ${deviceId} binary ${data.length} bytes`);
    } else {
      const str = data.toString();
      // Log SF2 chunk sends compactly (they're frequent during upload)
      if (str.includes('"sf2_chunk"')) {
        if (!ws._chunkCount) ws._chunkCount = 0;
        ws._chunkCount++;
        if (ws._chunkCount % 10 === 0) {
          console.log(`[app→dev] ${deviceId} sf2_chunk #${ws._chunkCount} (${data.length} bytes)`);
        }
      } else {
        console.log(`[app→dev] ${deviceId} text: ${str.slice(0, 200)}`);
      }
    }
    const device = devices.get(deviceId);
    if (device) {
      // Check device WS buffer pressure
      const buffered = device.ws.bufferedAmount || 0;
      if (buffered > 50000) {
        console.log(`[app→dev] ${deviceId} WARNING: device ws buffered ${buffered} bytes`);
      }
      safeSend(device.ws, data, isBinary);
    } else {
      console.log(`[app→dev] ${deviceId} DROPPED — device not connected!`);
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

// Safe send — catches errors on dead sockets (supports text + binary)
function safeSend(ws, data, isBinary) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(data, { binary: !!isBinary });
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
