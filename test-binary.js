#!/usr/bin/env node
// Minimal test: send a tiny binary message and a small one to ESP32 via relay

const WebSocket = require('ws');
const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';

console.log('[test] Connecting...');
const ws = new WebSocket(RELAY_URL);

ws.on('open', () => {
  console.log('[test] Connected');
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    console.log(`[test] Got binary: ${data.length} bytes`);
    return;
  }
  const str = data.toString();
  try {
    const msg = JSON.parse(str);
    if (msg.t === 'note_on' || msg.t === 'note_off' || msg.t === 'sensors') return;
    console.log(`[test] Got: ${str.slice(0, 300)}`);

    if (msg.t === 'device_status' && msg.online) {
      console.log('[test] Device online. Starting upload...');
      ws.send(JSON.stringify({
        t: 'sf2_upload_start',
        name: 'tiny_test.sf2',
        size: 10,
      }));
    }

    if (msg.t === 'sf2_upload_ready') {
      console.log('[test] Device ready! Sending 10-byte binary...');
      // Send a tiny 10-byte binary message
      const tiny = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A]);
      ws.send(tiny, { binary: true }, (err) => {
        if (err) console.log('[test] Send error:', err);
        else console.log('[test] Binary sent successfully (ws callback)');
      });

      setTimeout(() => {
        console.log('[test] Sending sf2_upload_end...');
        ws.send(JSON.stringify({ t: 'sf2_upload_end' }));
      }, 2000);
    }

    if (msg.t === 'sf2_uploaded') {
      console.log(`[test] Result: ok=${msg.ok} size=${msg.size} expected=${msg.expected}`);
      // Cleanup
      ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_delete', name: 'tiny_test.sf2' }));
      setTimeout(() => { ws.close(); process.exit(msg.ok ? 0 : 1); }, 2000);
    }

    if (msg.t === 'sf2_upload_error') {
      console.log(`[test] Error: ${msg.msg}`);
      ws.close();
      process.exit(1);
    }
  } catch (_) {}
});

ws.on('error', (err) => { console.error('[test] Error:', err.message); process.exit(1); });
setTimeout(() => { console.log('[test] TIMEOUT'); ws.close(); process.exit(1); }, 30000);
