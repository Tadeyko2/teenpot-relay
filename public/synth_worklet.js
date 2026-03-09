// AudioWorklet processor for TeenPot Synth
// Runs on the audio rendering thread — immune to main thread stalls
class SynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(16384);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.size = 16384;
    this.lastSample = 0;

    this.port.onmessage = (e) => {
      const samples = e.data;
      for (let i = 0; i < samples.length; i++) {
        this.buffer[this.writeIdx] = samples[i];
        this.writeIdx = (this.writeIdx + 1) % this.size;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0][0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      if (this.readIdx !== this.writeIdx) {
        // Buffer has data — play it
        this.lastSample = this.buffer[this.readIdx];
        this.buffer[this.readIdx] = 0;
        this.readIdx = (this.readIdx + 1) % this.size;
        output[i] = this.lastSample;
      } else {
        // Buffer empty — fade to zero smoothly instead of hard click
        this.lastSample *= 0.995;
        output[i] = this.lastSample;
      }
    }
    return true;
  }
}

registerProcessor('synth-processor', SynthProcessor);
