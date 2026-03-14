#!/usr/bin/env node
// Test larger upload (100KB) with 1024-byte chunks

const WebSocket = require('ws');
const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';
const TEST_FILENAME = 'test_100k.sf2';
const TEST_SIZE = 102400; // 100KB
const CHUNK_SIZE = 1024;

console.log(`[test] Upload ${TEST_SIZE} bytes (${(TEST_SIZE/1024).toFixed(0)} KB) in ${CHUNK_SIZE}-byte chunks...`);
const ws = new WebSocket(RELAY_URL);
let phase = 'connecting';

ws.on('open', () => console.log('[test] Connected'));

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  try {
    const msg = JSON.parse(data.toString());
    if (msg.t === 'note_on' || msg.t === 'note_off' || msg.t === 'sensors') return;
    console.log(`[test] ${msg.t}: ${JSON.stringify(msg).slice(0, 200)}`);

    if (msg.t === 'device_status' && msg.online && phase === 'connecting') {
      phase = 'uploading';
      ws.send(JSON.stringify({ t: 'sf2_upload_start', name: TEST_FILENAME, size: TEST_SIZE }));
    }

    if (msg.t === 'sf2_upload_ready') {
      console.log('[test] Sending chunks...');
      sendChunks();
    }

    if (msg.t === 'sf2_uploaded') {
      if (msg.ok && msg.size === TEST_SIZE) {
        console.log(`[test] SUCCESS! ${msg.size}/${msg.expected} bytes`);
        phase = 'verifying';
        ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_list' }));
      } else {
        console.log(`[test] FAILED: ok=${msg.ok} size=${msg.size}/${msg.expected}`);
        ws.close(); process.exit(1);
      }
    }

    if (msg.t === 'sf2_list' && phase === 'verifying') {
      const f = msg.files?.find(f => f.name === TEST_FILENAME);
      console.log(`[test] Verified: ${f ? `${f.name} size=${f.size}` : 'NOT FOUND'}`);
      ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_delete', name: TEST_FILENAME }));
      setTimeout(() => { ws.close(); process.exit(0); }, 2000);
    }

    if (msg.t === 'sf2_upload_error') {
      console.log(`[test] ERROR: ${msg.msg}`);
      ws.close(); process.exit(1);
    }
  } catch (_) {}
});

async function sendChunks() {
  const data = Buffer.alloc(TEST_SIZE, 0x42);
  let sent = 0;
  const totalChunks = Math.ceil(TEST_SIZE / CHUNK_SIZE);
  const startTime = Date.now();

  for (let offset = 0; offset < TEST_SIZE; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, TEST_SIZE);
    const chunk = data.subarray(offset, end);
    ws.send(chunk, { binary: true });
    sent += chunk.length;

    // Progress every 10 chunks
    const chunkNum = Math.floor(offset / CHUNK_SIZE) + 1;
    if (chunkNum % 10 === 0) {
      const pct = ((sent / TEST_SIZE) * 100).toFixed(0);
      process.stdout.write(`\r[test] Progress: ${pct}% (${sent}/${TEST_SIZE})`);
    }

    // Pace: 10ms delay per chunk
    await new Promise(r => setTimeout(r, 10));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[test] Sent ${sent} bytes in ${totalChunks} chunks (${elapsed}s)`);

  setTimeout(() => {
    console.log('[test] Sending sf2_upload_end...');
    ws.send(JSON.stringify({ t: 'sf2_upload_end' }));
  }, 1000);
}

ws.on('error', (err) => { console.error('[test] Error:', err.message); process.exit(1); });
setTimeout(() => { console.log('[test] TIMEOUT'); ws.close(); process.exit(1); }, 120000);
