// Turns mic audio (Float32 at the AudioContext rate, 24 kHz) into 16-bit PCM chunks of ~100 ms.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(2400);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.chunk[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.len === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(2400);
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
