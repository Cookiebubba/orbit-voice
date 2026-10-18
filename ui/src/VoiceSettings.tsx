// Voice + speaking speed. Changes save right away and apply mid-conversation.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";

type Voice = { id: string; name: string; gender: string };
type VoiceState = { voice: string; speed: number; minSpeed: number; maxSpeed: number; voices: Voice[] };

async function post(url: string, body: object) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export default function VoiceSettings() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [speed, setSpeed] = useState(1);
  const [preview, setPreview] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    fetch("/api/voice")
      .then((r) => r.json())
      .then((s: VoiceState) => {
        setState(s);
        setSpeed(s.speed);
      })
      .catch(() => setError("Couldn't load voice settings."));
    return () => {
      audio.current?.pause();
      clearTimeout(saveTimer.current);
    };
  }, []);

  const save = async (change: { voice?: string; speed?: number }) => {
    setError("");
    const r = await post("/api/settings", change);
    if (r.ok) {
      const saved = await r.json();
      setState((s) => (s ? { ...s, voice: saved.voice, speed: saved.speed } : s));
    } else setError("Couldn't save that setting.");
  };

  const changeSpeed = (v: number) => {
    setSpeed(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save({ speed: v }), 350);
  };

  const playPreview = async () => {
    if (preview === "playing") {
      audio.current?.pause();
      setPreview("idle");
      return;
    }
    setPreview("loading");
    setError("");
    try {
      const r = await post("/api/voice/preview", { voice: state?.voice, speed });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Preview failed.");
      const url = URL.createObjectURL(await r.blob());
      audio.current?.pause();
      const a = new Audio(url);
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
      <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-[13px] text-white/50">
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
    <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-[14px] font-medium">Grok's voice</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-white/50">Changes apply right away, even mid-conversation.</p>

      <label className="mt-4 mb-1.5 block text-[12px] text-white/50">Voice</label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <select
            value={state.voice}
            onChange={(e) => save({ voice: e.target.value })}
            className="h-10 w-full appearance-none rounded-xl border border-white/15 bg-[#111] pr-8 pl-3 text-[13px] text-white outline-none hover:border-white/30 focus:border-white/50"
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
          <ChevronDown size={15} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-white/50" />
        </div>
        <button
          onClick={playPreview}
          aria-label={preview === "playing" ? "Stop preview" : "Preview voice"}
          title={preview === "playing" ? "Stop preview" : "Preview this voice"}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-white/15 px-3 text-[13px] text-white/80 hover:border-white/35 hover:text-white"
        >
          {preview === "loading" ? <Loader2 size={14} className="animate-spin" /> : preview === "playing" ? <Square size={12} /> : <Play size={13} />}
          {preview === "playing" ? "Stop" : "Preview"}
        </button>
      </div>

      <div className="mt-5 mb-1.5 flex items-baseline justify-between">
        <label className="text-[12px] text-white/50">Talking speed</label>
        <span className="text-[13px] font-medium tabular-nums">{speed.toFixed(2)}×</span>
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
        style={{ background: `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,.15) ${pct}%)` }}
      />
      <div className="mt-1 flex justify-between text-[11.5px] text-white/40">
        <span>Slower</span>
        <button onClick={() => changeSpeed(1)} className={cn("hover:text-white", speed === 1 && "invisible")}>
          Reset to 1×
        </button>
        <span>Faster</span>
      </div>

      {error && <p className="mt-3 text-[12.5px] text-amber-400">{error}</p>}
    </section>
  );
}
