// Hands mic audio to the wake-word recognizer in ~85 ms Float32 chunks (4096 samples).
class FloatCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(4096);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.chunk[this.len++] = ch[i];
      if (this.len === this.chunk.length) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(4096);
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('float-capture', FloatCapture);
