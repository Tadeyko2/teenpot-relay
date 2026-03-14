const WebSocket = require('ws');
const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';
const TEST_FILENAME = 'test_800k.sf2';
const TEST_SIZE = 819200; // 800KB - similar to real SF2 files
const CHUNK_SIZE = 1024;

console.log(`[test] Upload ${(TEST_SIZE/1024).toFixed(0)} KB in ${CHUNK_SIZE}-byte chunks...`);
const ws = new WebSocket(RELAY_URL);
let phase = 'connecting';

ws.on('open', () => console.log('[test] Connected'));
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  try {
    const msg = JSON.parse(data.toString());
    if (['note_on','note_off','sensors','device_info'].includes(msg.t)) return;
    console.log(`[test] ${msg.t}`);

    if (msg.t === 'device_status' && msg.online && phase === 'connecting') {
      phase = 'uploading';
      ws.send(JSON.stringify({ t: 'sf2_upload_start', name: TEST_FILENAME, size: TEST_SIZE }));
    }
    if (msg.t === 'sf2_upload_ready') sendChunks();
    if (msg.t === 'sf2_uploaded') {
      console.log(`[test] Result: ok=${msg.ok} size=${msg.size}/${msg.expected}`);
      if (msg.ok) {
        console.log('[test] SUCCESS!');
        ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_delete', name: TEST_FILENAME }));
        setTimeout(() => { ws.close(); process.exit(0); }, 3000);
      } else {
        ws.close(); process.exit(1);
      }
    }
    if (msg.t === 'sf2_upload_error') {
      console.log(`[test] ERROR: ${msg.msg}`);
      ws.close(); process.exit(1);
    }
    if (msg.t === 'sf2_deleted') console.log('[test] Cleanup done');
  } catch (_) {}
});

async function sendChunks() {
  const data = Buffer.alloc(TEST_SIZE, 0x55);
  const startTime = Date.now();
  for (let offset = 0; offset < TEST_SIZE; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, TEST_SIZE);
    ws.send(data.subarray(offset, end), { binary: true });
    if ((offset / CHUNK_SIZE) % 100 === 0) {
      process.stdout.write(`\r[test] ${((offset/TEST_SIZE)*100).toFixed(0)}%`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[test] Sent ${(TEST_SIZE/1024).toFixed(0)} KB in ${elapsed}s`);
  setTimeout(() => ws.send(JSON.stringify({ t: 'sf2_upload_end' })), 1000);
}

ws.on('error', (err) => { console.error(err.message); process.exit(1); });
setTimeout(() => { console.log('[test] TIMEOUT'); ws.close(); process.exit(1); }, 300000);
