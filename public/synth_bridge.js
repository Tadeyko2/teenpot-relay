// Web Audio API bridge for TeenPot Synth
// AudioWorklet (preferred) with ScriptProcessorNode fallback

var SynthBridge = {
  audioCtx: null,
  workletNode: null,
  processor: null,
  ringBuffer: null,
  readIndex: 0,
  writeIndex: 0,
  bufferSize: 8192,
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
        if (!AC) return Promise.resolve(false);
        this.audioCtx = new AC();
      } catch(e) {
        console.error('[SynthBridge] AudioContext creation failed:', e);
        return Promise.resolve(false);
      }
    }

    console.log('[SynthBridge] start: state:', this.audioCtx.state);

    var resumePromise;
    if (this.audioCtx.state === 'suspended') {
      resumePromise = this.audioCtx.resume().catch(function() {});
    } else {
      resumePromise = Promise.resolve();
    }

    return resumePromise.then(function() {
      if (self.audioCtx.audioWorklet) {
        return self.audioCtx.audioWorklet.addModule('synth_worklet.js').then(function() {
          self.workletNode = new AudioWorkletNode(self.audioCtx, 'synth-processor');
          self.workletNode.connect(self.audioCtx.destination);
          self.useWorklet = true;
          self.totalFed = 0;
          self.startTime = self.audioCtx.currentTime;
          self.isRunning = true;
          console.log('[SynthBridge] started with AudioWorklet, sampleRate:', self.audioCtx.sampleRate);
          return true;
        }).catch(function(e) {
          console.warn('[SynthBridge] AudioWorklet failed, fallback:', e);
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
      this.processor = this.audioCtx.createScriptProcessor(1024, 0, 1);
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

// === AUTO-UNLOCK: Native DOM handler fires BEFORE Flutter's event pipeline ===
// This is the only reliable way to unlock AudioContext on iOS Safari.
(function() {
  function unlock() {
    if (!SynthBridge.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        SynthBridge.audioCtx = new AC();
        console.log('[AutoUnlock] Created AudioContext, state:', SynthBridge.audioCtx.state);
      }
    }
    if (SynthBridge.audioCtx && SynthBridge.audioCtx.state === 'suspended') {
      SynthBridge.audioCtx.resume();
      // Play silent buffer — iOS requires actual audio output to fully unlock
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
  // Capture phase = fires before Flutter can intercept
  ['touchstart', 'touchend', 'mousedown', 'click', 'pointerdown', 'keydown'].forEach(function(evt) {
    document.addEventListener(evt, unlock, { capture: true, passive: true });
  });
})();
