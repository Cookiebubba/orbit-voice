// Qubit's voice in Settings: real speech made by Kitten on this computer, at the voice and speed you
// chose (POST /api/claude-voice/preview, which needs no call and costs nothing). One line at a time,
// a new one fades the old one out, and a tap on the output gives his mouth its real loudness.
// No speech models yet: nothing plays, the caption stands alone.
import { volumeGain } from "../playback.js";
import { postJson } from "../useAppState";

const CUT_S = 0.03; // a new line fades the old one out over this long
const KEEP = 32; // lines kept decoded

export type SaidLine = { seconds: number; wait: number };

export function createSpeech({ volume, sid, speed }: { volume: () => number; sid: () => number; speed: () => number }) {
  let ctx: AudioContext | null = null;
  let bus: GainNode | null = null;
  let tap: AnalyserNode | null = null;
  const tapData = new Float32Array(1024);
  const cache = new Map<string, AudioBuffer>();
  let current: { src: AudioBufferSourceNode; gain: GainNode; start: number; end: number } | null = null;
  let token = 0;
  let asking: AbortController | null = null;

  const build = () => {
    if (ctx) return ctx;
    ctx = new AudioContext();
    bus = ctx.createGain();
    bus.gain.value = volumeGain(volume());
    tap = ctx.createAnalyser();
    tap.fftSize = 1024;
    tap.connect(bus).connect(ctx.destination);
    return ctx;
  };

  const fade = (was: NonNullable<typeof current>) => {
    const now = ctx!.currentTime;
    try {
      was.gain.gain.cancelScheduledValues(now);
      was.gain.gain.setValueAtTime(was.gain.gain.value, now);
      was.gain.gain.linearRampToValueAtTime(0, now + CUT_S);
      was.src.stop(now + CUT_S + 0.01);
    } catch {}
    return now + CUT_S;
  };
  const cut = () => {
    if (!current || !ctx) return ctx?.currentTime ?? 0;
    const was = current;
    current = null;
    return fade(was);
  };

  /** Says `text`, `delay` seconds from now. Resolves to how long it takes, or null if it can't. */
  async function say(text: string, delay = 0): Promise<SaidLine | null> {
    const me = ++token;
    asking?.abort();
    asking = null;
    try {
      const ac = build();
      if (ac.state === "suspended") void ac.resume();
      const free = cut();
      const key = `${sid()}|${speed()}|${text}`;
      let buf = cache.get(key);
      if (!buf) {
        const abort = new AbortController();
        asking = abort;
        const r = await fetch("/api/claude-voice/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice: sid(), speed: speed() }),
          signal: abort.signal,
        });
        if (!r.ok || me !== token) return null;
        buf = await ac.decodeAudioData(await r.arrayBuffer());
        if (cache.size >= KEEP) cache.delete(cache.keys().next().value as string);
        cache.set(key, buf);
        if (me !== token) return null;
      }
      const src = ac.createBufferSource();
      src.buffer = buf;
      const gain = ac.createGain();
      const start = Math.max(free, ac.currentTime + 0.005) + delay;
      gain.gain.setValueAtTime(1, start);
      src.connect(gain).connect(tap!);
      src.start(start);
      const now = { src, gain, start, end: start + buf.duration };
      current = now;
      src.onended = () => {
        if (current === now) current = null;
      };
      return { seconds: buf.duration, wait: start - ac.currentTime };
    } catch {
      return null; // aborted, or no audio device: the caption stands alone
    }
  }

  return {
    say,
    stop() {
      token++;
      asking?.abort();
      asking = null;
      cut();
    },
    /** Follows the volume live, mid-sentence too, with a short glide. */
    setVolume() {
      if (bus && ctx) bus.gain.setTargetAtTime(volumeGain(volume()), ctx.currentTime, 0.015);
    },
    talking: () => !!current && !!ctx && ctx.currentTime >= current.start && ctx.currentTime < current.end,
    /** His mouth: how loud the line is now (before the volume). */
    level() {
      if (!tap || !ctx || !current || ctx.currentTime < current.start) return 0;
      tap.getFloatTimeDomainData(tapData);
      let sum = 0;
      for (let i = 0; i < tapData.length; i++) sum += tapData[i] * tapData[i];
      return Math.min(1, Math.sqrt(sum / tapData.length) * 5);
    },
    close() {
      this.stop();
      void ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}
export type Speech = ReturnType<typeof createSpeech>;

/** The sample behind the Preview button: Claude voice's on this computer, Grok's through xAI. */
export async function fetchSample(engine: "claude" | "grok", voice: string | number, speedValue: number): Promise<Blob> {
  const r = await postJson(engine === "claude" ? "/api/claude-voice/preview" : "/api/voice/preview", { voice, speed: speedValue });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Preview failed.");
  return r.blob();
}
