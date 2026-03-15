// Web Audio API bridge for TeenPot Synth
// ScriptProcessor on mobile (reliable), AudioWorklet on desktop (preferred)

var SynthBridge = {
  audioCtx: null,
  workletNode: null,
  processor: null,
  ringBuffer: null,
  readIndex: 0,
  writeIndex: 0,
  bufferSize: 32768,
  isRunning: false,
  useWorklet: false,

  totalFed: 0,
  startTime: 0,

  // Detect mobile browsers — force ScriptProcessor (AudioWorklet postMessage unreliable)
  _isMobile: /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),

  warmup: function() {
    if (!this.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      console.log('[SynthBridge] warmup: created AudioContext, state:', this.audioCtx.state);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
      try {
        var buf = this.audioCtx.createBuffer(1, 1, 22050);
        var src = this.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this.audioCtx.destination);
        src.start(0);
      } catch(e) {}
      console.log('[SynthBridge] warmup: resume + silent buffer in gesture context');
    }
  },

  start: function() {
    if (this.isRunning) return Promise.resolve(true);
    var self = this;

    if (!this.audioCtx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { console.error('[SynthBridge] No AudioContext API'); return Promise.resolve(false); }
        this.audioCtx = new AC();
      } catch(e) {
        console.error('[SynthBridge] AudioContext creation failed:', e);
        return Promise.resolve(false);
      }
    }

    console.log('[SynthBridge] start: state:', this.audioCtx.state, 'sampleRate:', this.audioCtx.sampleRate, 'mobile:', this._isMobile);

    var resumePromise;
    if (this.audioCtx.state === 'suspended') {
      resumePromise = this.audioCtx.resume().catch(function() {});
    } else {
      resumePromise = Promise.resolve();
    }

    return resumePromise.then(function() {
      console.log('[SynthBridge] after resume: state:', self.audioCtx.state);

      // Mobile: always use ScriptProcessor — AudioWorklet postMessage is unreliable
      if (self._isMobile) {
        console.log('[SynthBridge] Mobile detected — using ScriptProcessor (skipping AudioWorklet)');
        return self._startScriptProcessor();
      }

      // Desktop: try AudioWorklet with 3s timeout
      if (self.audioCtx.audioWorklet) {
        var workletLoaded = self.audioCtx.audioWorklet.addModule('synth_worklet.js');
        var timeout = new Promise(function(_, reject) {
          setTimeout(function() { reject(new Error('AudioWorklet addModule timeout (3s)')); }, 3000);
        });

        return Promise.race([workletLoaded, timeout]).then(function() {
          self.workletNode = new AudioWorkletNode(self.audioCtx, 'synth-processor');
          self.workletNode.connect(self.audioCtx.destination);
          self.useWorklet = true;
          self.totalFed = 0;
          self.startTime = self.audioCtx.currentTime;
          self.isRunning = true;
          console.log('[SynthBridge] started with AudioWorklet');
          return true;
        }).catch(function(e) {
          console.warn('[SynthBridge] AudioWorklet failed:', e.message, '— falling back to ScriptProcessor');
          return self._startScriptProcessor();
        });
      } else {
        return self._startScriptProcessor();
      }
    });
  },

  tryResume: function() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(function() {});
      try {
        var buf = this.audioCtx.createBuffer(1, 1, 22050);
        var src = this.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this.audioCtx.destination);
        src.start(0);
      } catch(e) {}
      return false;
    }
    return this.audioCtx ? this.audioCtx.state === 'running' : false;
  },

  _startScriptProcessor: function() {
    try {
      this.ringBuffer = new Float32Array(this.bufferSize);
      this.readIndex = 0;
      this.writeIndex = 0;
      this.processor = this.audioCtx.createScriptProcessor(2048, 0, 1);
      this.processor.connect(this.audioCtx.destination);
      var self = this;
      this.processor.onaudioprocess = function(e) {
        var output = e.outputBuffer.getChannelData(0);
        for (var i = 0; i < output.length; i++) {
          output[i] = self.ringBuffer[self.readIndex];
          self.ringBuffer[self.readIndex] = 0;
          self.readIndex = (self.readIndex + 1) % self.bufferSize;
        }
      };
      this.useWorklet = false;
      this.isRunning = true;
      console.log('[SynthBridge] started with ScriptProcessor, sampleRate:', this.audioCtx.sampleRate);
      return true;
    } catch(e) {
      console.error('[SynthBridge] ScriptProcessor error:', e);
      return false;
    }
  },

  // Manual test tone — call from Dart to verify audio on phone
  testTone: function() {
    if (!this.audioCtx) return 'no_ctx';
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    try {
      var osc = this.audioCtx.createOscillator();
      var gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      gain.gain.value = 0.3;
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      var t = this.audioCtx.currentTime;
      osc.start(t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.stop(t + 0.5);
      return 'played:' + this.audioCtx.state;
    } catch(e) {
      return 'error:' + e.message;
    }
  },

  getDiagnostics: function() {
    return JSON.stringify({
      hasCtx: !!this.audioCtx,
      state: this.audioCtx ? this.audioCtx.state : 'none',
      sampleRate: this.audioCtx ? this.audioCtx.sampleRate : 0,
      isRunning: this.isRunning,
      useWorklet: this.useWorklet,
      mobile: this._isMobile,
      buffered: this.isRunning ? this.getBuffered() : 0,
      totalFed: this.totalFed
    });
  },

  getBuffered: function() {
    if (this.useWorklet) {
      var elapsed = this.audioCtx.currentTime - this.startTime;
      var consumed = Math.floor(elapsed * this.audioCtx.sampleRate);
      return Math.max(0, this.totalFed - consumed);
    } else {
      var b = this.writeIndex - this.readIndex;
      if (b < 0) b += this.bufferSize;
      return b;
    }
  },

  feed: function(samples) {
    if (!this.isRunning) return;
    this.totalFed += samples.length;
    if (this.useWorklet) {
      this.workletNode.port.postMessage(samples);
    } else {
      if (!this.ringBuffer) return;
      for (var i = 0; i < samples.length; i++) {
        this.ringBuffer[this.writeIndex] = samples[i];
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      }
    }
  },

  stop: function() {
    if (this.workletNode) { this.workletNode.disconnect(); this.workletNode = null; }
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
    this.isRunning = false;
    this.useWorklet = false;
  },

  // === Microphone Recording ===
  _recStream: null,
  _recSource: null,
  _recProcessor: null,
  _recChunks: null,
  _isRecording: false,

  startRecording: function() {
    var self = this;
    if (this._isRecording) return Promise.resolve(true);

    // Ensure AudioContext exists (we need its sampleRate)
    if (!this.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.audioCtx = new AC();
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      self._recStream = stream;
      self._recChunks = [];

      // Create a separate AudioContext for recording to avoid conflicts
      var recCtx = self.audioCtx;
      self._recSource = recCtx.createMediaStreamSource(stream);

      // ScriptProcessor for capturing raw PCM (works across all browsers)
      self._recProcessor = recCtx.createScriptProcessor(4096, 1, 1);
      self._recProcessor.onaudioprocess = function(e) {
        if (!self._isRecording) return;
        var input = e.inputBuffer.getChannelData(0);
        // Copy the buffer (it gets reused)
        self._recChunks.push(new Float32Array(input));
      };

      self._recSource.connect(self._recProcessor);
      self._recProcessor.connect(recCtx.destination); // must connect to destination for onaudioprocess to fire
      self._isRecording = true;
      console.log('[SynthBridge] Recording started, sampleRate:', recCtx.sampleRate);
      return true;
    }).catch(function(e) {
      console.error('[SynthBridge] getUserMedia error:', e);
      return false;
    });
  },

  stopRecording: function() {
    if (!this._isRecording) return null;
    this._isRecording = false;

    // Disconnect and clean up
    if (this._recProcessor) {
      this._recProcessor.disconnect();
      this._recProcessor = null;
    }
    if (this._recSource) {
      this._recSource.disconnect();
      this._recSource = null;
    }
    if (this._recStream) {
      this._recStream.getTracks().forEach(function(t) { t.stop(); });
      this._recStream = null;
    }

    // Flatten chunks into single Float32Array
    if (!this._recChunks || this._recChunks.length === 0) return null;

    var totalLen = 0;
    for (var i = 0; i < this._recChunks.length; i++) {
      totalLen += this._recChunks[i].length;
    }

    var result = new Float32Array(totalLen);
    var offset = 0;
    for (var i = 0; i < this._recChunks.length; i++) {
      result.set(this._recChunks[i], offset);
      offset += this._recChunks[i].length;
    }

    this._recChunks = null;
    console.log('[SynthBridge] Recording stopped, samples:', totalLen);
    return result;
  },

  isRecording: function() {
    return this._isRecording;
  },

  getSampleRate: function() {
    return this.audioCtx ? this.audioCtx.sampleRate : 44100;
  },

  getState: function() {
    return this.audioCtx ? this.audioCtx.state : 'closed';
  },

  probeTeenPot: function(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal, mode: 'cors' })
      .then(function(r) { clearTimeout(timer); if (!r.ok) return ''; return r.text(); })
      .then(function(t) { return t || ''; })
      .catch(function() { clearTimeout(timer); return ''; });
  },

  downloadBlob: function(uint8Array, filename) {
    var blob = new Blob([uint8Array], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
};

// === iOS AUDIO SESSION FIX ===
// On iOS, Web Audio uses "ambient" session which respects the mute switch.
// HTML5 <audio> uses "playback" session which ignores the mute switch.
// By playing a silent <audio> element first, we force the entire audio session
// to "playback" mode, making Web Audio also ignore the mute switch.
// This is required because iOS users commonly have the mute switch on.
(function() {
  var silentAudio = null;
  var audioSessionFixed = false;

  function fixAudioSession() {
    if (audioSessionFixed) return;
    // Create silent looping <audio> — forces iOS "playback" audio session
    silentAudio = document.createElement('audio');
    silentAudio.setAttribute('playsinline', '');
    silentAudio.setAttribute('webkit-playsinline', '');
    // Generate a tiny WAV in JS — 1 second of silence at 8kHz mono 8-bit
    var header = new Uint8Array([
      0x52,0x49,0x46,0x46, // "RIFF"
      0x24,0x20,0x00,0x00, // file size - 8
      0x57,0x41,0x56,0x45, // "WAVE"
      0x66,0x6D,0x74,0x20, // "fmt "
      0x10,0x00,0x00,0x00, // chunk size 16
      0x01,0x00,           // PCM format
      0x01,0x00,           // mono
      0x40,0x1F,0x00,0x00, // 8000 Hz
      0x40,0x1F,0x00,0x00, // byte rate
      0x01,0x00,           // block align
      0x08,0x00,           // 8 bits per sample
      0x64,0x61,0x74,0x61, // "data"
      0x00,0x20,0x00,0x00  // data size = 8192 bytes
    ]);
    var silence = new Uint8Array(8192);
    for (var i = 0; i < 8192; i++) silence[i] = 128; // 128 = silence in 8-bit PCM
    var wav = new Blob([header, silence], { type: 'audio/wav' });
    silentAudio.src = URL.createObjectURL(wav);
    silentAudio.loop = true;
    silentAudio.volume = 0.01; // near-silent but not zero
    var playPromise = silentAudio.play();
    if (playPromise) {
      playPromise.then(function() {
        audioSessionFixed = true;
        console.log('[iOS] Audio session forced to playback mode');
      }).catch(function() {});
    }
  }

  function unlock() {
    // Fix iOS audio session FIRST
    fixAudioSession();

    if (!SynthBridge.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        SynthBridge.audioCtx = new AC();
        console.log('[AutoUnlock] Created AudioContext, state:', SynthBridge.audioCtx.state);
      }
    }
    if (SynthBridge.audioCtx && SynthBridge.audioCtx.state === 'suspended') {
      SynthBridge.audioCtx.resume();
      try {
        var buf = SynthBridge.audioCtx.createBuffer(1, 1, 22050);
        var src = SynthBridge.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(SynthBridge.audioCtx.destination);
        src.start(0);
      } catch(e) {}
      console.log('[AutoUnlock] resume + silent buffer played');
    }
  }
  ['touchstart', 'touchend', 'mousedown', 'click', 'pointerdown', 'keydown'].forEach(function(evt) {
    document.addEventListener(evt, unlock, { capture: true, passive: true });
  });
})();
