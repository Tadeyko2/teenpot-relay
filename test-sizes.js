#!/usr/bin/env node
// Test different binary chunk sizes to find the breaking point

const WebSocket = require('ws');
const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';

const SIZES_TO_TEST = [100, 512, 1024, 2048, 4096];
let currentTest = 0;

function runTest(size) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== Testing ${size} bytes ===`);
    const ws = new WebSocket(RELAY_URL);
    const filename = `size_test_${size}.sf2`;
    let timeout;

    ws.on('open', () => {});

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'note_on' || msg.t === 'note_off' || msg.t === 'sensors') return;

        if (msg.t === 'device_status' && msg.online) {
          ws.send(JSON.stringify({ t: 'sf2_upload_start', name: filename, size }));
        }

        if (msg.t === 'sf2_upload_ready') {
          console.log(`[${size}] Device ready, sending ${size} bytes...`);
          const data = Buffer.alloc(size, 0x42);
          ws.send(data, { binary: true });
          setTimeout(() => {
            ws.send(JSON.stringify({ t: 'sf2_upload_end' }));
          }, 2000);
        }

        if (msg.t === 'sf2_uploaded') {
          console.log(`[${size}] Result: ok=${msg.ok} size=${msg.size}/${msg.expected}`);
          ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_delete', name: filename }));
          clearTimeout(timeout);
          setTimeout(() => { ws.close(); resolve(msg.ok); }, 1000);
        }

        if (msg.t === 'sf2_upload_error') {
          console.log(`[${size}] Error: ${msg.msg}`);
          clearTimeout(timeout);
          ws.close();
          resolve(false);
        }
      } catch (_) {}
    });

    ws.on('error', (err) => { reject(err); });
    timeout = setTimeout(() => {
      console.log(`[${size}] TIMEOUT`);
      ws.close();
      resolve(false);
    }, 20000);
  });
}

async function main() {
  for (const size of SIZES_TO_TEST) {
    try {
      const ok = await runTest(size);
      console.log(`[${size}] ${ok ? 'PASS' : 'FAIL'}`);
      if (!ok) {
        console.log(`\nBinary frames fail at ${size} bytes`);
        break;
      }
      // Wait between tests for ESP32 to stabilize
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.log(`[${size}] ERROR: ${err.message}`);
      break;
    }
  }
  process.exit(0);
}

main();
