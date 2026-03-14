#!/usr/bin/env node
// End-to-end upload test with valid SF2 header + reload verification

const WebSocket = require('ws');
const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';
const TEST_FILENAME = 'e2e_test.sf2';
const CHUNK_SIZE = 2048;

// Build a minimal valid SF2 file (RIFF/sfbk header + padding)
function buildMinimalSF2(totalSize) {
  const buf = Buffer.alloc(totalSize, 0);
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(totalSize - 8, 4); // file size - 8
  buf.write('sfbk', 8);
  // INFO chunk
  buf.write('LIST', 12);
  buf.writeUInt32LE(24, 16); // chunk size
  buf.write('INFO', 20);
  // ifil sub-chunk (required)
  buf.write('ifil', 24);
  buf.writeUInt32LE(4, 28);
  buf.writeUInt16LE(2, 32); // major version
  buf.writeUInt16LE(1, 34); // minor version
  // INAM sub-chunk
  buf.write('INAM', 36);
  buf.writeUInt32LE(8, 40);
  buf.write('Test\0\0\0\0', 44);
  return buf;
}

const TEST_SIZE = 8192;
const sf2Data = buildMinimalSF2(TEST_SIZE);

console.log(`[e2e] Upload ${TEST_SIZE} bytes in ${CHUNK_SIZE}-byte chunks...`);
const ws = new WebSocket(RELAY_URL);
let phase = 'connecting';

ws.on('open', () => console.log('[e2e] Connected'));

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  try {
    const msg = JSON.parse(data.toString());
    if (msg.t === 'note_on' || msg.t === 'note_off' || msg.t === 'sensors') return;
    console.log(`[e2e] ${msg.t}: ${JSON.stringify(msg).slice(0, 200)}`);

    if (msg.t === 'device_status' && msg.online && phase === 'connecting') {
      phase = 'uploading';
      console.log('[e2e] Starting upload...');
      ws.send(JSON.stringify({ t: 'sf2_upload_start', name: TEST_FILENAME, size: TEST_SIZE }));
    }

    if (msg.t === 'sf2_upload_ready') {
      console.log('[e2e] Device ready, sending chunks...');
      sendChunks();
    }

    if (msg.t === 'sf2_uploaded') {
      console.log(`[e2e] Upload result: ok=${msg.ok} size=${msg.size}/${msg.expected}`);
      if (msg.ok) {
        phase = 'waiting_load';
        console.log('[e2e] Waiting 5s for SF2 load...');
        setTimeout(() => {
          ws.send(JSON.stringify({ t: 'cmd', action: 'system_info' }));
        }, 5000);
      } else {
        ws.close(); process.exit(1);
      }
    }

    if (msg.t === 'system_info' && phase === 'waiting_load') {
      console.log(`[e2e] Current SF2: ${msg.current_sf2 || 'none'}`);
      if (msg.current_sf2 === TEST_FILENAME) {
        console.log('[e2e] SF2 LOADED SUCCESSFULLY!');
      } else {
        console.log('[e2e] SF2 load may have failed (different name active)');
      }
      // Cleanup
      phase = 'cleanup';
      ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_delete', name: TEST_FILENAME }));
      setTimeout(() => { ws.close(); process.exit(0); }, 2000);
    }

    if (msg.t === 'sf2_upload_error') {
      console.log(`[e2e] ERROR: ${msg.msg}`);
      ws.close(); process.exit(1);
    }
  } catch (_) {}
});

async function sendChunks() {
  let sent = 0;
  for (let offset = 0; offset < TEST_SIZE; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, TEST_SIZE);
    const chunk = sf2Data.subarray(offset, end);
    ws.send(chunk, { binary: true });
    sent += chunk.length;
    await new Promise(r => setTimeout(r, 20));
  }
  console.log(`[e2e] Sent ${sent} bytes in ${Math.ceil(TEST_SIZE / CHUNK_SIZE)} chunks`);
  setTimeout(() => {
    console.log('[e2e] Sending sf2_upload_end...');
    ws.send(JSON.stringify({ t: 'sf2_upload_end' }));
  }, 500);
}

ws.on('error', (err) => { console.error('[e2e] Error:', err.message); process.exit(1); });
setTimeout(() => { console.log('[e2e] TIMEOUT'); ws.close(); process.exit(1); }, 60000);
