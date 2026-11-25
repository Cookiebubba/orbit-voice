// Voice + speaking speed, for any voice engine. Changes save right away and apply mid-conversation.
// Grok: xAI's voices, previewed through xAI. Claude / Gemini CLI: Kitten's 8 voices or Kokoro
// English's 11 British & US voices, previewed on this PC. Gemini Live: Google's prebuilt native
// voices, applied directly in call.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { thisComputer } from "./desktop";
import { DEFAULT_VOLUME, volumeGain } from "./playback.js";

type Voice = { id: string; name: string; gender: string };
type VoiceState = { voice: string; speed: number; minSpeed: number; maxSpeed: number; voices: Voice[] };

async function post(url: string, body: object) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// Each engine's voice list, kept for the session: when Settings switches engines or local TTS
// packs, the other card opens at its real size instead of growing out of a "Loading voices…" box.
export type Engine = "grok" | "claude" | "gemini-cli" | "gemini-live";
export type TtsPack = "kitten" | "kokoro-en" | "kokoro-v1";
const cache: Record<string, VoiceState> = {};
const cacheKey = (engine: Engine, tts: TtsPack = "kitten") => `${engine}:${tts}`;

export function prefetchVoices(engine: Engine, tts: TtsPack = "kitten") {
  const local = engine === "claude" || engine === "gemini-cli";
  const url = local ? `/api/voice?engine=${engine}&tts=${tts}` : `/api/voice?engine=${engine}`;
  const key = cacheKey(engine, tts);
  return fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((s: VoiceState | null) => (s ? (cache[key] = s) : null))
    .catch(() => null);
}

export default function VoiceSettings({
  engine = "grok",
  tts = "kitten",
  volume = DEFAULT_VOLUME,
  onVolume,
  syncKey,
}: {
  engine?: Engine;
  tts?: TtsPack;
  volume?: number;
  onVolume?: (v: number) => void;
  syncKey?: number;
}) {
  const localSpeech = engine === "claude" || engine === "gemini-cli";
  const isKokoro = localSpeech && (tts === "kokoro-en" || tts === "kokoro-v1");
  const geminiLive = engine === "gemini-live";
  const key = cacheKey(engine, localSpeech ? tts : "kitten");
  const [state, setState] = useState<VoiceState | null>(cache[key] ?? null);
  const [speed, setSpeed] = useState(cache[key]?.speed ?? 1);
  const [preview, setPreview] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Volume: shown at once as you drag, saved a moment later (and it follows "talk quieter" by voice).
  const [vol, setVol] = useState(volume);
  const volTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setVol(volume), [volume]);
  const changeVolume = (v: number) => {
    setVol(v);
    if (audio.current) audio.current.volume = volumeGain(v);
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(() => onVolume?.(v), 150);
  };

  useEffect(() => {
    let active = true;
    const effectiveTts: TtsPack = localSpeech ? tts : "kitten";
    const k = cacheKey(engine, effectiveTts);
    setError("");
    setPreview("idle");
    setState(cache[k] ?? null);
    if (cache[k]) setSpeed(cache[k].speed);
    prefetchVoices(engine, effectiveTts).then((s) => {
      if (!active) return;
      if (!s) return setError("Couldn't load voice settings.");
      setState(s);
      setSpeed(s.speed);
    });
    return () => {
      active = false;
      audio.current?.pause();
      clearTimeout(saveTimer.current);
      clearTimeout(volTimer.current);
    };
  }, [engine, tts, localSpeech, syncKey]);

  const save = async (change: { voice?: string; speed?: number }) => {
    setError("");
    const body =
      change.voice !== undefined
        ? isKokoro
          ? { kokoroVoice: Number(change.voice) }
          : localSpeech
            ? { claudeVoice: Number(change.voice) }
            : geminiLive
              ? { geminiVoice: change.voice }
              : change
        : change;
    const r = await post("/api/settings", body);
    if (r.ok) {
      const saved = await r.json();
      const savedVoice = isKokoro
        ? String(saved.kokoroVoice)
        : localSpeech
          ? String(saved.claudeVoice)
          : geminiLive
            ? String(saved.geminiVoice)
            : saved.voice;
      const k = cacheKey(engine, localSpeech ? tts : "kitten");
      setState((s) => {
        const next = s ? { ...s, voice: savedVoice, speed: saved.speed } : s;
        if (next) cache[k] = next;
        return next;
      });
    } else setError("Couldn't save that setting.");
  };

  const changeSpeed = (v: number) => {
    setSpeed(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save({ speed: v }), 350);
  };

  const playPreview = async () => {
    if (geminiLive) return;
    if (preview === "playing") {
      audio.current?.pause();
      setPreview("idle");
      return;
    }
    setPreview("loading");
    setError("");
    try {
      const payload = isKokoro ? { voice: state?.voice, speed, tts: "kokoro-en" } : { voice: state?.voice, speed };
      const r = await post(localSpeech ? "/api/claude-voice/preview" : "/api/voice/preview", payload);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Preview failed.");
      const url = URL.createObjectURL(await r.blob());
      audio.current?.pause();
      const a = new Audio(url);
      a.volume = volumeGain(vol);
      audio.current = a;
      a.onended = () => {
        setPreview("idle");
        URL.revokeObjectURL(url);
      };
      await a.play();
      setPreview("playing");
    } catch (e: any) {
      setPreview("idle");
      setError(e.message);
    }
  };

  if (!state) {
    return (
      <section className="border-t border-line pt-5 text-[13px] text-muted">
        {error || "Loading voices…"}
      </section>
    );
  }

  const groups = [
    { label: "Female", voices: state.voices.filter((v) => v.gender === "female") },
    { label: "Male", voices: state.voices.filter((v) => v.gender === "male") },
    { label: "Other", voices: state.voices.filter((v) => v.gender !== "female" && v.gender !== "male") },
  ].filter((g) => g.voices.length);
  const known = state.voices.some((v) => v.id === state.voice);
  const pct = ((speed - state.minSpeed) / (state.maxSpeed - state.minSpeed)) * 100;

  return (
    <section className="border-t border-line pt-5">
      <h3 className="eyebrow">{localSpeech ? "Orbit's voice" : geminiLive ? "Gemini's voice" : "Grok's voice"}</h3>
      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
        {localSpeech
          ? `Spoken on ${thisComputer}${isKokoro ? " with Kokoro English" : ""}. Pick one by ear with Preview. Changes apply right away.`
          : geminiLive
            ? "Gemini Live native voices apply directly when you start a call."
            : "Changes apply right away, even mid-conversation."}
      </p>

      <label className="mt-4 mb-1.5 block text-[12px] text-muted">Voice</label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <select
            value={state.voice}
            onChange={(e) => save({ voice: e.target.value })}
            className="h-10 w-full appearance-none rounded-xl border border-line bg-soft pr-8 pl-3 text-[13px] text-fg outline-none hover:border-black/20 focus:border-black/40 focus:bg-white"
          >
            {!known && <option value={state.voice}>{state.voice}</option>}
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={15} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
        </div>
        <button
          onClick={playPreview}
          disabled={geminiLive}
          aria-label={geminiLive ? "Preview unavailable for Gemini Live" : preview === "playing" ? "Stop preview" : "Preview voice"}
          title={geminiLive ? "Gemini Live voices apply directly in call" : preview === "playing" ? "Stop preview" : "Preview this voice"}
          className="flex h-10 items-center gap-1.5 rounded-xl bg-fg px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {preview === "loading" ? <Loader2 size={14} className="animate-spin" /> : preview === "playing" ? <Square size={12} /> : <Play size={13} />}
          {preview === "playing" ? "Stop" : "Preview"}
        </button>
      </div>
      {geminiLive && <p className="mt-1.5 text-[11.5px] leading-snug text-faint">Voice preview isn't available for Gemini Live; your selection applies directly in call.</p>}

      <div className="mt-5 mb-1.5 flex items-baseline justify-between">
        <label className="text-[12px] text-muted">Talking speed</label>
        <span className="text-[13px] font-medium text-fg tabular-nums">{speed.toFixed(2)}×</span>
      </div>
      <input
        type="range"
        min={state.minSpeed}
        max={state.maxSpeed}
        step={0.05}
        value={speed}
        onChange={(e) => changeSpeed(Number(e.target.value))}
        aria-label="Talking speed"
        className="speed-slider w-full"
        style={{ background: `linear-gradient(to right, #0d0d0d ${pct}%, rgba(0,0,0,.1) ${pct}%)` }}
      />
      <div className="mt-1 flex justify-between text-[11.5px] text-faint">
        <span>Slower</span>
        <button onClick={() => changeSpeed(1)} className={cn("hover:text-fg", speed === 1 && "invisible")}>
          Reset to 1×
        </button>
        <span>Faster</span>
      </div>

      <div className="mt-5 mb-1.5 flex items-baseline justify-between">
        <label className="text-[12px] text-muted">Volume</label>
        <span className="text-[13px] font-medium text-fg tabular-nums">{Math.round(vol * 100)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={vol}
        onChange={(e) => changeVolume(Number(e.target.value))}
        aria-label="Volume"
        className="speed-slider w-full"
        style={{ background: `linear-gradient(to right, #0d0d0d ${vol * 100}%, rgba(0,0,0,.1) ${vol * 100}%)` }}
      />
      <div className="mt-1 flex justify-between text-[11.5px] text-faint">
        <span>Quiet</span>
        <span>Loud</span>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-faint">Applies at once, mid-sentence too. You can also say "talk quieter" or "louder".</p>

      {error && <p className="mt-3 text-[12.5px] text-amber-700">{error}</p>}
    </section>
  );
}
