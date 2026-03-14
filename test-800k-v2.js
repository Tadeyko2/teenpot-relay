const WebSocket = require('ws');
const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';
const TEST_FILENAME = 'test_800k.sf2';
const TEST_SIZE = 819200;
const CHUNK_SIZE = 2048; // 2KB chunks (largest proven safe)

console.log(`[test] Upload ${(TEST_SIZE/1024).toFixed(0)} KB in ${CHUNK_SIZE}-byte chunks...`);
const ws = new WebSocket(RELAY_URL);
let phase = 'connecting';

ws.on('open', () => console.log('[test] Connected'));
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  try {
    const msg = JSON.parse(data.toString());
    if (['note_on','note_off','sensors','device_info'].includes(msg.t)) return;
    console.log(`[test] ${msg.t}: ${JSON.stringify(msg).slice(0, 200)}`);

    if (msg.t === 'device_status' && msg.online && phase === 'connecting') {
      phase = 'uploading';
      ws.send(JSON.stringify({ t: 'sf2_upload_start', name: TEST_FILENAME, size: TEST_SIZE }));
    }
    if (msg.t === 'sf2_upload_ready') sendChunks();
    if (msg.t === 'sf2_uploaded') {
      if (msg.ok) {
        console.log(`[test] SUCCESS! ${msg.size}/${msg.expected}`);
        ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_delete', name: TEST_FILENAME }));
        setTimeout(() => { ws.close(); process.exit(0); }, 3000);
      } else {
        console.log(`[test] FAILED: size=${msg.size}/${msg.expected}`);
        ws.close(); process.exit(1);
      }
    }
    if (msg.t === 'sf2_upload_error') {
      console.log(`[test] ERROR: ${msg.msg}`);
      ws.close(); process.exit(1);
    }
    if (msg.t === 'sf2_deleted') console.log('[test] Cleanup done');
    if (msg.t === 'device_offline') {
      console.log('[test] DEVICE WENT OFFLINE!');
      // Wait for reconnect
    }
  } catch (_) {}
});

async function sendChunks() {
  const data = Buffer.alloc(TEST_SIZE, 0x55);
  const startTime = Date.now();
  const totalChunks = Math.ceil(TEST_SIZE / CHUNK_SIZE);
  
  for (let offset = 0; offset < TEST_SIZE; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, TEST_SIZE);
    ws.send(data.subarray(offset, end), { binary: true });
    const chunkNum = Math.floor(offset / CHUNK_SIZE);
    if (chunkNum % 50 === 0) {
      const pct = ((offset / TEST_SIZE) * 100).toFixed(0);
      process.stdout.write(`\r[test] ${pct}% (${chunkNum}/${totalChunks} chunks)`);
    }
    // 20ms delay between 2KB chunks = ~100 KB/s throughput
    await new Promise(r => setTimeout(r, 20));
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[test] Sent ${(TEST_SIZE/1024).toFixed(0)} KB in ${elapsed}s (${totalChunks} chunks)`);
  setTimeout(() => {
    console.log('[test] Sending sf2_upload_end...');
    ws.send(JSON.stringify({ t: 'sf2_upload_end' }));
  }, 2000);
}

ws.on('error', (err) => { console.error(err.message); process.exit(1); });
setTimeout(() => { console.log('[test] TIMEOUT'); ws.close(); process.exit(1); }, 120000);
