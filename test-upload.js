#!/usr/bin/env node
// Test SF2 upload via relay WebSocket
// Waits for sf2_upload_ready before sending binary chunks

const WebSocket = require('ws');

const RELAY_URL = 'wss://teenpot-relay.onrender.com/app/D7F900';
const TEST_FILENAME = 'test_upload.sf2';
const TEST_SIZE = 8192; // 8KB test file

console.log(`[test] Connecting to ${RELAY_URL}...`);
const ws = new WebSocket(RELAY_URL);

let phase = 'connecting'; // connecting → listing → uploading → verifying → done

ws.on('open', () => {
  console.log('[test] Connected to relay');
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    console.log(`[test] Got binary: ${data.length} bytes`);
    return;
  }
  const str = data.toString();

  // Skip noisy MIDI messages
  try {
    const msg = JSON.parse(str);
    if (msg.t === 'note_on' || msg.t === 'note_off' || msg.t === 'sensors') {
      return; // skip
    }
    console.log(`[test] Got: ${str.slice(0, 300)}`);
    handleMessage(msg);
  } catch (_) {
    console.log(`[test] Got non-JSON: ${str.slice(0, 100)}`);
  }
});

function handleMessage(msg) {
  if (msg.t === 'device_status' && msg.online) {
    console.log('[test] Device is online');
    phase = 'listing';
    console.log('[test] Requesting SF2 list...');
    ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_list' }));
  }

  if (msg.t === 'device_status' && !msg.online) {
    console.log('[test] Device is OFFLINE');
    ws.close();
    process.exit(1);
  }

  if (msg.t === 'sf2_list' && phase === 'listing') {
    console.log(`[test] SF2 files: ${JSON.stringify(msg.files?.map(f => f.name))}`);
    phase = 'uploading';
    console.log(`[test] Starting upload: ${TEST_FILENAME} (${TEST_SIZE} bytes)`);
    ws.send(JSON.stringify({
      t: 'sf2_upload_start',
      name: TEST_FILENAME,
      size: TEST_SIZE,
    }));
    console.log('[test] Sent sf2_upload_start, waiting for sf2_upload_ready...');
  }

  if (msg.t === 'sf2_upload_ready' && phase === 'uploading') {
    console.log('[test] Device ready! Sending binary chunks...');
    sendChunks();
  }

  if (msg.t === 'sf2_upload_error') {
    console.log(`[test] UPLOAD ERROR: ${msg.msg}`);
    ws.close();
    process.exit(1);
  }

  if (msg.t === 'sf2_uploaded') {
    console.log(`[test] Upload result: ok=${msg.ok} size=${msg.size} expected=${msg.expected}`);
    if (msg.ok) {
      console.log('[test] SUCCESS! Verifying...');
      phase = 'verifying';
      ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_list' }));
    } else {
      console.log('[test] FAILED');
      ws.close();
      process.exit(1);
    }
  }

  if (msg.t === 'sf2_list' && phase === 'verifying') {
    const testFile = msg.files?.find(f => f.name === TEST_FILENAME);
    if (testFile) {
      console.log(`[test] Verified: ${TEST_FILENAME} exists, size=${testFile.size}`);
      if (testFile.size === TEST_SIZE) {
        console.log('[test] SIZE MATCHES! Upload fully verified.');
      } else {
        console.log(`[test] SIZE MISMATCH: expected ${TEST_SIZE}, got ${testFile.size}`);
      }
    } else {
      console.log(`[test] WARNING: ${TEST_FILENAME} not found in list`);
    }
    // Cleanup
    console.log('[test] Deleting test file...');
    ws.send(JSON.stringify({ t: 'cmd', action: 'sf2_delete', name: TEST_FILENAME }));
    phase = 'done';
  }

  if (msg.t === 'sf2_deleted' && phase === 'done') {
    console.log(`[test] Delete result: ok=${msg.ok}`);
    console.log('[test] All done!');
    ws.close();
    process.exit(0);
  }
}

function sendChunks() {
  const chunkSize = 4096;
  const testData = Buffer.alloc(TEST_SIZE, 0x42); // Fill with 'B'

  for (let offset = 0; offset < TEST_SIZE; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, TEST_SIZE);
    const chunk = testData.subarray(offset, end);
    ws.send(chunk);
    console.log(`[test] Sent chunk: ${offset}-${end} (${end - offset} bytes)`);
  }

  // Send upload end after a brief delay to let chunks arrive
  setTimeout(() => {
    console.log('[test] Sending sf2_upload_end...');
    ws.send(JSON.stringify({ t: 'sf2_upload_end' }));
  }, 1000);
}

ws.on('close', (code, reason) => {
  console.log(`[test] Disconnected: code=${code}`);
});

ws.on('error', (err) => {
  console.error(`[test] Error: ${err.message}`);
  process.exit(1);
});

// Timeout
setTimeout(() => {
  console.log('[test] TIMEOUT — no response after 60 seconds');
  ws.close();
  process.exit(1);
}, 60000);
