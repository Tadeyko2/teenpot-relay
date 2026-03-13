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
const crypto = require('crypto');
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

// ============================================================
// SF2 temporary file store (in-memory, auto-cleanup)
// ============================================================
// token → { buffer, filename, size, uploadedAt, downloaded }
const sf2Store = new Map();
const SF2_MAX_SIZE = 16 * 1024 * 1024; // 16 MB
const SF2_EXPIRY_MS = 10 * 60 * 1000;  // 10 minutes

// Cleanup expired/downloaded SF2 files every 60s
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of sf2Store) {
    if (entry.downloaded || (now - entry.uploadedAt > SF2_EXPIRY_MS)) {
      sf2Store.delete(token);
      console.log(`[sf2-store] Cleaned up ${entry.filename} (token=${token.slice(0,8)}..)`);
    }
  }
}, 60000);

// Upload event ring buffer for debugging
const uploadLog = [];
const UPLOAD_LOG_MAX = 5000;
function logUploadEvent(evt) {
  uploadLog.push({ ts: Date.now(), ...evt });
  if (uploadLog.length > UPLOAD_LOG_MAX) uploadLog.shift();
}

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

  // Upload log — ring buffer of recent SF2 upload events
  if (pathname === '/api/upload-log') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(uploadLog, null, 2));
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

  // CORS preflight for SF2 endpoints
  if (req.method === 'OPTIONS' && (pathname.startsWith('/api/sf2/'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // SF2 upload: App POSTs raw bytes, gets back a download token/URL
  if (pathname === '/api/sf2/upload' && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const filename = urlObj.searchParams.get('name') || 'preset.sf2';
    const chunks = [];
    let totalSize = 0;

    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > SF2_MAX_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: 'File too large (max 16MB)' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (res.writableEnded) return; // already sent 413
      const buffer = Buffer.concat(chunks);
      const token = crypto.randomBytes(16).toString('hex');
      sf2Store.set(token, {
        buffer,
        filename,
        size: buffer.length,
        uploadedAt: Date.now(),
        downloaded: false,
      });

      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const dlUrl = `${proto}://${host}/api/sf2/dl/${token}`;

      console.log(`[sf2-store] Stored ${filename} (${buffer.length} bytes, token=${token.slice(0,8)}..)`);
      logUploadEvent({ dir: 'sf2-store', filename, size: buffer.length, token: token.slice(0,8) });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ok: true, token, url: dlUrl, size: buffer.length }));
    });

    req.on('error', (err) => {
      console.error('[sf2-store] Upload error:', err.message);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // SF2 download: ESP32 GETs the stored file by token
  const dlMatch = pathname.match(/^\/api\/sf2\/dl\/([a-f0-9]{32})$/);
  if (dlMatch && req.method === 'GET') {
    const token = dlMatch[1];
    const entry = sf2Store.get(token);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'Not found or expired' }));
      return;
    }

    console.log(`[sf2-store] Download ${entry.filename} (${entry.size} bytes, token=${token.slice(0,8)}..)`);
    logUploadEvent({ dir: 'sf2-download', filename: entry.filename, size: entry.size, token: token.slice(0,8) });

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': entry.size,
      'Content-Disposition': `attachment; filename="${entry.filename}"`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(entry.buffer);
    entry.downloaded = true;
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
    ws.isAlive = true;  // Any message = device is alive (prevents heartbeat kill)
    const info = devices.get(deviceId);
    if (info) info.lastMessageAt = new Date().toISOString();

    // Log SF2-related and upload-related messages from device
    if (!isBinary) {
      const str = data.toString();
      if (str.includes('sf2') || str.includes('system_info') || str.includes('upload') || str.includes('ack')) {
        console.log(`[dev→app] ${deviceId} text: ${str.slice(0, 300)}`);
        logUploadEvent({ dir: 'dev→app', deviceId, msg: str.slice(0, 300) });
      }
    }

    const watchers = appClients.get(deviceId);
    if (!watchers || watchers.size === 0) return;

    for (const appWs of watchers) {
      safeSend(appWs, data, isBinary);
    }
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'none';
    console.log(`[device] ${deviceId} disconnected code=${code} reason=${reasonStr}`);
    logUploadEvent({ dir: 'device-close', deviceId, code, reason: reasonStr });
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
    logUploadEvent({ dir: 'device-error', deviceId, error: err.message });
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
    ws.isAlive = true;  // Any message = app is alive
    if (isBinary) {
      console.log(`[app→dev] ${deviceId} binary ${data.length} bytes`);
    } else {
      const str = data.toString();

      // Intercept sf2_relay_push — relay pushes stored file to device as binary chunks
      if (str.includes('"sf2_relay_push"')) {
        try {
          const msg = JSON.parse(str);
          pushSf2ToDevice(ws, deviceId, msg);
        } catch (e) {
          console.error(`[relay-push] Parse error:`, e.message);
          safeSend(ws, JSON.stringify({ t: 'sf2_push_error', msg: e.message }));
        }
        return; // Don't forward to device
      }

      if (str.includes('"sf2_chunk"')) {
        if (!ws._chunkCount) ws._chunkCount = 0;
        ws._chunkCount++;
        const device = devices.get(deviceId);
        const buffered = device ? (device.ws.bufferedAmount || 0) : -1;
        const readyState = device ? device.ws.readyState : -1;
        logUploadEvent({
          dir: 'app→dev', deviceId,
          chunk: ws._chunkCount,
          msgBytes: data.length,
          devBuffered: buffered,
          devReady: readyState,
        });
        if (ws._chunkCount <= 12 || ws._chunkCount % 10 === 0) {
          console.log(`[app→dev] ${deviceId} sf2_chunk #${ws._chunkCount} (${data.length}B, buf=${buffered}, ready=${readyState})`);
        }
      } else {
        console.log(`[app→dev] ${deviceId} text: ${str.slice(0, 200)}`);
        if (str.includes('sf2') || str.includes('upload')) {
          logUploadEvent({ dir: 'app→dev', deviceId, msg: str.slice(0, 200) });
        }
      }
    }
    const device = devices.get(deviceId);
    if (device) {
      safeSend(device.ws, data, isBinary);
    } else {
      console.log(`[app→dev] ${deviceId} DROPPED — device not connected!`);
      logUploadEvent({ dir: 'app→dev', deviceId, error: 'device not connected' });
    }
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'none';
    console.log(`[app] disconnected from ${deviceId} code=${code} reason=${reasonStr}`);
    logUploadEvent({ dir: 'app-close', deviceId, code, reason: reasonStr });
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

// ============================================================
// SF2 relay push — relay sends stored file to device as base64 text chunks
// Uses ESP32's existing text upload handler: sf2_upload_start → sf2_chunk → sf2_upload_end
// ============================================================

const PUSH_CHUNK_SIZE = 4096;  // 4KB raw data per chunk (becomes ~5.5KB base64)
const PUSH_CHUNK_DELAY = 20;   // ms between chunks — let ESP32 decode + buffer
const PUSH_ACK_INTERVAL = 20;  // ESP32 sends sf2_ack every 20 chunks

async function pushSf2ToDevice(appWs, deviceId, msg) {
  const { token, name, size } = msg;
  const entry = sf2Store.get(token);
  if (!entry) {
    safeSend(appWs, JSON.stringify({ t: 'sf2_push_error', msg: 'Token expired or not found' }));
    return;
  }

  const device = devices.get(deviceId);
  if (!device || device.ws.readyState !== device.ws.OPEN) {
    safeSend(appWs, JSON.stringify({ t: 'sf2_push_error', msg: 'Device not connected' }));
    return;
  }

  const devWs = device.ws;
  const buffer = entry.buffer;
  const totalSize = buffer.length;
  const totalChunks = Math.ceil(totalSize / PUSH_CHUNK_SIZE);

  console.log(`[relay-push] Starting base64 push: ${name} (${totalSize} bytes, ${totalChunks} chunks) to ${deviceId}`);
  logUploadEvent({ dir: 'relay-push-start', deviceId, filename: name, size: totalSize, chunks: totalChunks });

  // Step 1: Send upload_start to device
  const startMsg = JSON.stringify({ t: 'sf2_upload_start', name, size: totalSize });
  safeSend(devWs, startMsg);

  // Wait for sf2_upload_ready from device
  const ready = await waitForDeviceMessage(devWs, deviceId, 'sf2_upload_ready', 15000);
  if (!ready) {
    console.log(`[relay-push] Device didn't respond with upload_ready`);
    safeSend(appWs, JSON.stringify({ t: 'sf2_push_error', msg: 'Device not ready (timeout)' }));
    return;
  }

  // Step 2: Send base64-encoded text chunks (sf2_chunk format)
  let offset = 0;
  let chunkNum = 0;

  while (offset < totalSize) {
    const end = Math.min(offset + PUSH_CHUNK_SIZE, totalSize);
    const chunk = buffer.slice(offset, end);
    const b64 = chunk.toString('base64');

    // Check device still connected
    if (devWs.readyState !== devWs.OPEN) {
      console.log(`[relay-push] Device disconnected during push at ${offset}/${totalSize}`);
      safeSend(appWs, JSON.stringify({ t: 'sf2_push_error', msg: 'Device disconnected during upload' }));
      return;
    }

    // Back-pressure: wait if device WS buffer > 32KB
    let bpWaits = 0;
    while (devWs.bufferedAmount > 32768) {
      await sleep(50);
      bpWaits++;
      if (bpWaits > 100 || devWs.readyState !== devWs.OPEN) {
        safeSend(appWs, JSON.stringify({ t: 'sf2_push_error', msg: 'Device stalled (backpressure)' }));
        return;
      }
    }

    // Send as text frame: {"t":"sf2_chunk","d":"<base64>"}
    const chunkMsg = JSON.stringify({ t: 'sf2_chunk', d: b64 });
    safeSend(devWs, chunkMsg);
    offset = end;
    chunkNum++;

    // Every ACK interval: wait for ESP32's sf2_ack before continuing
    if (chunkNum % PUSH_ACK_INTERVAL === 0) {
      const ack = await waitForDeviceMessage(devWs, deviceId, 'sf2_ack', 15000);
      if (!ack) {
        console.log(`[relay-push] No ACK from device after chunk #${chunkNum}`);
        safeSend(appWs, JSON.stringify({ t: 'sf2_push_error', msg: `No ACK after chunk ${chunkNum}` }));
        return;
      }

      // Report progress to app
      safeSend(appWs, JSON.stringify({
        t: 'sf2_download_progress',
        offset,
        size: totalSize,
      }));

      // Longer pause after ACK batch — let ESP32 flush PSRAM to SD
      await sleep(PUSH_CHUNK_DELAY * 3);
    } else {
      await sleep(PUSH_CHUNK_DELAY);
    }

    if (chunkNum % 100 === 0) {
      console.log(`[relay-push] ${deviceId} chunk #${chunkNum}/${totalChunks}: ${offset}/${totalSize} (buf=${devWs.bufferedAmount})`);
    }
  }

  // Step 3: Send upload_end
  const endMsg = JSON.stringify({ t: 'sf2_upload_end' });
  safeSend(devWs, endMsg);

  // Wait for sf2_uploaded confirmation
  const result = await waitForDeviceMessage(devWs, deviceId, 'sf2_uploaded', 30000);

  if (result) {
    console.log(`[relay-push] Push complete: ${name} (${totalSize} bytes, ${chunkNum} chunks)`);
    logUploadEvent({ dir: 'relay-push-done', deviceId, filename: name, size: totalSize, chunks: chunkNum });
    safeSend(appWs, JSON.stringify({ t: 'sf2_downloaded', ok: true, name, size: totalSize }));
    entry.downloaded = true;
  } else {
    console.log(`[relay-push] Push failed: no upload confirmation`);
    safeSend(appWs, JSON.stringify({ t: 'sf2_push_error', msg: 'No upload confirmation from device' }));
  }
}

// Wait for a specific message type from device (via temporary listener)
function waitForDeviceMessage(devWs, deviceId, messageType, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; devWs.removeListener('message', handler); resolve(null); }
    }, timeoutMs);

    function handler(data, isBinary) {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === messageType) {
          if (!resolved) { resolved = true; clearTimeout(timer); devWs.removeListener('message', handler); resolve(msg); }
        }
        if (msg.t === 'sf2_upload_error') {
          if (!resolved) { resolved = true; clearTimeout(timer); devWs.removeListener('message', handler); resolve(null); }
        }
        // Forward to watching apps (ACKs, upload_ready, etc.)
        const watchers = appClients.get(deviceId);
        if (watchers) {
          for (const appWs of watchers) { safeSend(appWs, data); }
        }
      } catch (_) {}
    }

    devWs.on('message', handler);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      // Find which device/app this belongs to
      let who = 'unknown';
      for (const [id, d] of devices) {
        if (d.ws === ws) { who = `device:${id}`; break; }
      }
      if (who === 'unknown') {
        for (const [id, clients] of appClients) {
          if (clients.has(ws)) { who = `app:${id}`; break; }
        }
      }
      console.log(`[heartbeat] terminating dead connection: ${who}`);
      logUploadEvent({ dir: 'heartbeat-kill', who });
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
