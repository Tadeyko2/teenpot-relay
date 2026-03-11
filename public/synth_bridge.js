// Web Audio API bridge for TeenPot Synth
// AudioWorklet (preferred) with ScriptProcessorNode fallback

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

  warmup: function() {
    if (!this.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      console.log('[SynthBridge] warmup: created AudioContext, state:', this.audioCtx.state);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
      // iOS unlock: play a tiny silent buffer
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

    console.log('[SynthBridge] start: state:', this.audioCtx.state, 'sampleRate:', this.audioCtx.sampleRate);

    var resumePromise;
    if (this.audioCtx.state === 'suspended') {
      resumePromise = this.audioCtx.resume().catch(function() {});
    } else {
      resumePromise = Promise.resolve();
    }

    return resumePromise.then(function() {
      console.log('[SynthBridge] after resume: state:', self.audioCtx.state);

      // Try AudioWorklet with 3s timeout — addModule can hang on some mobile browsers
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
          self._diagnosticBeep();
          return true;
        }).catch(function(e) {
          console.warn('[SynthBridge] AudioWorklet failed:', e.message, '— falling back to ScriptProcessor');
          return self._startScriptProcessor();
        });
      } else {
        console.log('[SynthBridge] No audioWorklet API, using ScriptProcessor');
        return self._startScriptProcessor();
      }
    });
  },

  tryResume: function() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(function() {});
      // iOS silent buffer trick
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
      console.log('[SynthBridge] started with ScriptProcessor');
      this._diagnosticBeep();
      return true;
    } catch(e) {
      console.error('[SynthBridge] ScriptProcessor error:', e);
      return false;
    }
  },

  // Short quiet beep to verify audio pipeline works on this device
  _diagnosticBeep: function() {
    try {
      var osc = this.audioCtx.createOscillator();
      var gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      var t = this.audioCtx.currentTime;
      osc.start(t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.stop(t + 0.15);
      console.log('[SynthBridge] diagnostic beep played, state:', this.audioCtx.state);
    } catch(e) {
      console.error('[SynthBridge] diagnostic beep failed:', e);
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
    if (this.useWorklet) {
      this.workletNode.port.postMessage(samples);
      this.totalFed += samples.length;
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

// === iOS MUTE SWITCH BYPASS ===
// On iOS Safari, the hardware mute switch silences Web Audio ("ambient" session).
// Playing through an HTML5 <audio> element forces "playback" session category,
// which ignores the mute switch. We create a silent looping audio element.
(function() {
  var silentAudio = null;

  function ensureSilentAudio() {
    if (silentAudio) return;
    // Tiny silent WAV: 1 sample, 8kHz, mono, 8-bit
    silentAudio = document.createElement('audio');
    silentAudio.setAttribute('playsinline', '');
    silentAudio.setAttribute('webkit-playsinline', '');
    silentAudio.loop = true;
    // Base64-encoded minimal WAV (44 bytes header + 1 byte of silence)
    silentAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQAAAAA=';
    silentAudio.volume = 0.01;
    silentAudio.load();
  }

  function unlock() {
    // Force playback session via HTML5 audio (bypasses iOS mute switch)
    ensureSilentAudio();
    if (silentAudio.paused) {
      silentAudio.play().catch(function() {});
    }

    if (!SynthBridge.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        SynthBridge.audioCtx = new AC();
        console.log('[AutoUnlock] Created AudioContext, state:', SynthBridge.audioCtx.state);
      }
    }
    if (SynthBridge.audioCtx && SynthBridge.audioCtx.state === 'suspended') {
      SynthBridge.audioCtx.resume();
      // Play silent buffer via Web Audio too
      try {
        var buf = SynthBridge.audioCtx.createBuffer(1, 1, 22050);
        var src = SynthBridge.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(SynthBridge.audioCtx.destination);
        src.start(0);
      } catch(e) {}
      console.log('[AutoUnlock] resume + silent buffer + HTML5 audio played');
    }
  }
  // Capture phase = fires before Flutter can intercept
  ['touchstart', 'touchend', 'mousedown', 'click', 'pointerdown', 'keydown'].forEach(function(evt) {
    document.addEventListener(evt, unlock, { capture: true, passive: true });
  });
})();
