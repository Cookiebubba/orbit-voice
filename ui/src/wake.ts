// Runs inside the hidden wake-word page (wake.html), loaded in an iframe only while the wake word
// is switched on and Grok is off or asleep. Recognizes "Hey Grok" fully offline with a small
// Vosk model (no audio leaves the PC, no cost) and posts { type: "wake" } to the main window.
//
// It lives in its own page because the Vosk recognizer needs `eval` and WebAssembly, which the
// main window's stricter Content-Security-Policy doesn't allow. This page renders nothing.
//
// "Grok" isn't in the small model's vocabulary, so we listen for the closest words it does know
// ("hey rock", "hey brock", "okay rock"...) and give it decoys ("hey brooke", "hey rob"...) so
// similar-sounding names land on those instead. Tested on TTS clips: 10/10 "Hey Grok" across 9
// voices, 12/13 sound-alikes ignored (the miss: someone actually saying "Hey Brock").
import { createModel } from "vosk-browser";

const MODEL_FILE = "vosk-model-small-en-us-0.15.tar.gz";
const GRAMMAR = ["hey rock", "hey brock", "okay rock", "okay brock", "hey brooke", "hey brook", "hey rob", "hey bob", "hey rocky", "hey robert", "[unk]"];
const WAKE = /\b(hey|okay) (rock|brock)\b/;
const DEBOUNCE_MS = 2000;

const tell = (msg: { type: "status"; status: string; detail?: string } | { type: "wake" }) =>
  window.parent.postMessage({ source: "orbit-wake", ...msg }, location.origin);

async function main() {
  if (window.parent === window) return; // only meant to run inside Orbit's main window
  tell({ type: "status", status: "loading" });
  try {
    const model = await createModel(`${location.origin}/models/${MODEL_FILE}`);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule("float-worklet.js");
    const node = new AudioWorkletNode(ctx, "float-capture");
    const rec = new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify(GRAMMAR));
    let last = 0;
    rec.on("result", (m: any) => {
      const text: string = m?.result?.text || "";
      if (WAKE.test(text) && Date.now() - last > DEBOUNCE_MS) {
        last = Date.now();
        tell({ type: "wake" });
      }
    });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => rec.acceptWaveformFloat(e.data, ctx.sampleRate);
    ctx.createMediaStreamSource(stream).connect(node);
    // The main window removes this iframe to stop listening; release the mic promptly.
    window.addEventListener("pagehide", () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      model.terminate();
    });
    tell({ type: "status", status: "listening" });
  } catch (e: any) {
    tell({ type: "status", status: "error", detail: String(e?.message || e).slice(0, 200) });
  }
}

void main();
