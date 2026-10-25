// Developer testing only: the parity driver's preload (electron/parity-driver.js registers it on the
// session, so it runs in every Orbit page next to preload.cjs; never in the installed app, where the
// driver never loads). It puts window.__orbitParity in the page's own world, the object the pages
// fill with what the driver reads (ui/src/useVoice.ts, ui/src/App.tsx), and, with ORBIT_FAKE_MIC, a
// fake microphone: getUserMedia({ audio }) returns a stream from a WebAudio graph that plays the WAV
// clips the driver hands it (mic.play), one after another, and silence in between.
const { contextBridge, ipcRenderer } = require('electron');

let cfg = { fakeMic: false };
try {
  cfg = ipcRenderer.sendSync('parity:config') || cfg;
} catch {}

function setup(config) {
  if (window.__orbitParity) return;
  const P = { voice: null, app: null };
  Object.defineProperty(window, '__orbitParity', { value: P, configurable: false, enumerable: false, writable: false });
  if (!config.fakeMic || !navigator.mediaDevices) return;
  let ac = null;
  let dest = null;
  let tail = 0; // where the last clip ends (the fake mic's clock)
  let initial = null; // ORBIT_FAKE_MIC's own file: played once, when the mic first opens
  const mic = { opened: 0, clips: 0, lastClip: null };
  const ensure = () => {
    if (!ac) {
      ac = new AudioContext();
      dest = ac.createMediaStreamDestination();
      dest.channelCount = 1; // a mono mic (stereo clips are mixed down)
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  };
  async function play(b64, gapMs = 0) {
    const ctx = ensure();
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    const at = Math.max(ctx.currentTime + 0.02, tail > ctx.currentTime ? tail + gapMs / 1000 : ctx.currentTime + gapMs / 1000);
    src.start(at);
    tail = at + buf.duration;
    mic.clips++;
    mic.lastClip = { startsInMs: Math.round((at - ctx.currentTime) * 1000), durationMs: Math.round(buf.duration * 1000), sampleRate: buf.sampleRate, channels: buf.numberOfChannels };
    return mic.lastClip;
  }
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio || constraints.video) return real(constraints);
    ensure();
    mic.opened++;
    if (initial) {
      const b = initial;
      initial = null;
      play(b).catch(() => {});
    }
    // A clone per caller: a page that stops its tracks on hang-up leaves the fake mic working.
    return new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone()));
  };
  P.mic = {
    play,
    setInitial: (b64) => (initial = b64),
    get state() {
      return { ...mic, running: !!ac && ac.state === 'running', queuedMs: ac ? Math.max(0, Math.round((tail - ac.currentTime) * 1000)) : 0 };
    },
  };
}

try {
  contextBridge.executeInMainWorld({ func: setup, args: [cfg] });
} catch {}
