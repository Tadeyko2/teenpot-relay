const WebSocket = require('ws');
const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';
const TEST_FILENAME = 'Final_Test.sf2';
const TEST_SIZE = 500000; // 500KB
const CHUNK_SIZE = 2048;

console.log(`=== FINAL TEST: Upload ${(TEST_SIZE/1024).toFixed(0)} KB via relay ===`);
const ws = new WebSocket(RELAY_URL);
let phase = 'connecting';

ws.on('open', () => console.log('Connected to relay'));
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  try {
    const msg = JSON.parse(data.toString());
    if (['note_on','note_off','sensors','device_info'].includes(msg.t)) return;

    if (msg.t === 'device_status' && msg.online && phase === 'connecting') {
      phase = 'list1';
      console.log('1. Device online. Getting initial file list...');
      ws.send(JSON.stringify({t:'cmd', action:'sf2_list'}));
    }

    if (msg.t === 'sf2_list' && phase === 'list1') {
      console.log(`   Files: ${msg.files.map(f=>f.name).join(', ')}`);
      phase = 'uploading';
      console.log(`2. Starting upload: ${TEST_FILENAME} (${(TEST_SIZE/1024).toFixed(0)} KB)`);
      ws.send(JSON.stringify({t:'sf2_upload_start', name:TEST_FILENAME, size:TEST_SIZE}));
    }

    if (msg.t === 'sf2_upload_ready') {
      console.log(`   Device ready (PSRAM free: ${msg.psram_free})`);
      sendChunks();
    }

    if (msg.t === 'sf2_uploaded') {
      console.log(`3. Upload result: ok=${msg.ok} size=${msg.size}/${msg.expected}`);
      if (msg.ok) {
        phase = 'list2';
        console.log('4. Verifying file list...');
        ws.send(JSON.stringify({t:'cmd', action:'sf2_list'}));
      } else {
        console.log('FAILED!');
        ws.close(); process.exit(1);
      }
    }

    if (msg.t === 'sf2_list' && phase === 'list2') {
      const f = msg.files.find(f => f.name === TEST_FILENAME);
      console.log(`   Files: ${msg.files.map(f=>f.name+' ('+f.size+')').join(', ')}`);
      if (f && f.size === TEST_SIZE) {
        console.log(`   VERIFIED: ${TEST_FILENAME} = ${f.size} bytes`);
        // Check system info
        phase = 'sysinfo';
        ws.send(JSON.stringify({t:'cmd', action:'system_info'}));
      } else {
        console.log('   VERIFICATION FAILED!');
        ws.close(); process.exit(1);
      }
    }

    if (msg.t === 'system_info' && phase === 'sysinfo') {
      console.log(`5. System: sf2=${msg.current_sf2}, psram=${msg.psram_free}, heap=${msg.heap_free}`);
      phase = 'cleanup';
      console.log('6. Cleaning up test file...');
      ws.send(JSON.stringify({t:'cmd', action:'sf2_delete', name:TEST_FILENAME}));
    }

    if (msg.t === 'sf2_deleted' && phase === 'cleanup') {
      console.log(`   Delete: ok=${msg.ok}`);
      console.log('\n=== ALL TESTS PASSED ===');
      ws.close(); process.exit(0);
    }

    if (msg.t === 'sf2_upload_error') {
      console.log(`ERROR: ${msg.msg}`);
      ws.close(); process.exit(1);
    }
  } catch(_){}
});

async function sendChunks() {
  const data = Buffer.alloc(TEST_SIZE, 0x55);
  const startTime = Date.now();
  for (let offset = 0; offset < TEST_SIZE; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, TEST_SIZE);
    ws.send(data.subarray(offset, end), {binary: true});
    await new Promise(r => setTimeout(r, 10));
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   Sent ${(TEST_SIZE/1024).toFixed(0)} KB in ${elapsed}s`);
  setTimeout(() => ws.send(JSON.stringify({t:'sf2_upload_end'})), 1000);
}

ws.on('error', (err) => { console.error(err.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); ws.close(); process.exit(1); }, 120000);
