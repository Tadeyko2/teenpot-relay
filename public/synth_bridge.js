// Web Audio API bridge for TeenPot Synth
// AudioWorklet (preferred) with ScriptProcessorNode fallback
// AudioWorklet runs on a separate thread — immune to main thread stalls

var SynthBridge = {
  audioCtx: null,
  workletNode: null,
  processor: null,        // ScriptProcessor fallback
  ringBuffer: null,        // only used in fallback mode
  readIndex: 0,
  writeIndex: 0,
  bufferSize: 8192,
  isRunning: false,
  useWorklet: false,

  // Track how many samples we've fed vs how many have been consumed
  totalFed: 0,
  startTime: 0,

  start: function() {
    if (this.isRunning) return Promise.resolve(true);
    var self = this;

    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        console.error('[SynthBridge] No AudioContext support');
        return Promise.resolve(false);
      }
      this.audioCtx = new AudioCtx();
      console.log('[SynthBridge] AudioContext created, state:', this.audioCtx.state, 'sampleRate:', this.audioCtx.sampleRate);

      // iOS/Mobile: keep trying to resume on any user interaction
      var ctx = this.audioCtx;
      var resumeHandler = function() {
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().then(function() {
            console.log('[SynthBridge] AudioContext resumed after user gesture');
          }).catch(function() {});
        }
        if (ctx && ctx.state === 'running') {
          document.removeEventListener('touchstart', resumeHandler);
          document.removeEventListener('click', resumeHandler);
          document.removeEventListener('pointerdown', resumeHandler);
        }
      };
      document.addEventListener('touchstart', resumeHandler, { once: false, passive: true });
      document.addEventListener('click', resumeHandler, { once: false, passive: true });
      document.addEventListener('pointerdown', resumeHandler, { once: false, passive: true });
    } catch(e) {
      console.error('[SynthBridge] AudioContext creation failed:', e);
      return Promise.resolve(false);
    }

    // Ensure AudioContext is running before loading worklet
    var resumePromise;
    if (this.audioCtx.state === 'suspended') {
      console.log('[SynthBridge] AudioContext suspended, attempting resume...');
      resumePromise = this.audioCtx.resume().then(function() {
        console.log('[SynthBridge] AudioContext resumed, state:', self.audioCtx.state);
      }).catch(function(e) {
        // On mobile, resume may fail until user gesture — continue anyway,
        // the resumeHandler above will retry on touch/click
        console.warn('[SynthBridge] Resume failed (will retry on gesture):', e);
      });
    } else {
      resumePromise = Promise.resolve();
    }

    // Try AudioWorklet first (supported in Safari 14.1+)
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
          console.warn('[SynthBridge] AudioWorklet failed, falling back to ScriptProcessor:', e);
          return self._startScriptProcessor();
        });
      } else {
        return self._startScriptProcessor();
      }
    });
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
      console.log('[SynthBridge] started with ScriptProcessor (fallback), sampleRate:', this.audioCtx.sampleRate);
      return true;
    } catch(e) {
      console.error('[SynthBridge] ScriptProcessor start error:', e);
      return false;
    }
  },

  getBuffered: function() {
    if (this.useWorklet) {
      // Estimate: total fed minus total consumed by audio context
      var elapsed = this.audioCtx.currentTime - this.startTime;
      var consumed = Math.floor(elapsed * this.audioCtx.sampleRate);
      var buffered = this.totalFed - consumed;
      return Math.max(0, buffered);
    } else {
      var b = this.writeIndex - this.readIndex;
      if (b < 0) b += this.bufferSize;
      return b;
    }
  },

  feed: function(samples) {
    if (!this.isRunning) return;

    if (this.useWorklet) {
      // Send samples to worklet thread via port
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
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.isRunning = false;
    this.useWorklet = false;
    console.log('[SynthBridge] stopped');
  },

  getSampleRate: function() {
    return this.audioCtx ? this.audioCtx.sampleRate : 44100;
  },

  // Probe an IP for TeenPot identity with proper AbortController timeout.
  // Returns JSON string on success, empty string on failure.
  // AbortController actually cancels the TCP connection (unlike Dart timeout).
  // NOTE: Discovery now uses package:web directly, but this is kept as utility.
  probeTeenPot: function(url, timeoutMs) {
    console.log('[SynthBridge] probeTeenPot:', url, 'timeout:', timeoutMs);
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal, mode: 'cors' })
      .then(function(r) {
        clearTimeout(timer);
        console.log('[SynthBridge] probe response:', url, 'ok:', r.ok, 'status:', r.status);
        if (!r.ok) return '';
        return r.text();
      })
      .then(function(text) {
        if (text) console.log('[SynthBridge] probe body:', url, text.substring(0, 100));
        return text || '';
      })
      .catch(function(e) {
        clearTimeout(timer);
        return '';
      });
  },

  downloadBlob: function(uint8Array, filename) {
    var blob = new Blob([uint8Array], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('[SynthBridge] downloaded:', filename, uint8Array.length, 'bytes');
  }
};
