// Serialized into this acceptance run's main renderer before any native Start.
// No native AudioContext, microphone, worklet, oscillator or playback node is constructed.
export function installFakeAudio() {
  if (window.__managedAudio) return;
  const state = window.__managedAudio = { microphoneOpens: 0, tracksStopped: 0, contexts: 0, contextsClosed: 0,
    voiceSockets: 0, socketsClosed: 0, instance: crypto.randomUUID() };
  const parameter = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() { return this; }, disconnect() {}, gain: parameter(), frequency: parameter(), start() {}, stop() {},
    getFloatTimeDomainData(buffer) { buffer.fill(0); } });
  class Context {
    state = 'running'; sampleRate = 24000; destination = {}; outputLatency = 0; baseLatency = 0;
    audioWorklet = { async addModule() {} };
    constructor(options) { this.voice = options?.sampleRate === 24000; if (this.voice) state.contexts++; this.began = performance.now(); }
    get currentTime() { return (performance.now() - this.began) / 1000; }
    async resume() {}
    async close() { if (this.state !== 'closed' && this.voice) state.contextsClosed++; this.state = 'closed'; }
    createGain() { return node(); }
    createAnalyser() { return node(); }
    createMediaStreamSource() { return node(); }
    createOscillator() { return node(); }
    createBufferSource() { return node(); }
    createBuffer(_channels, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
  }
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: Context });
  Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: class { port = {}; connect() { return this; } disconnect() {} } });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    state.microphoneOpens++; let stopped = false;
    const track = { stop() { if (!stopped) state.tracksStopped++; stopped = true; } };
    return { getTracks: () => [track] };
  } });
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(url, ...rest) {
      super(url, ...rest);
      if (new URL(url).pathname === '/voice') { state.voiceSockets++; this.addEventListener('close', () => state.socketsClosed++); }
    }
  };
}
