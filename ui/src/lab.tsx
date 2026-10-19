// Orb lab (development only; not part of the built app). Tune how the orb looks while Claude is
// working, then copy the numbers into src/orbLook.ts.
//   npm --prefix ui run dev   →   http://localhost:5173/lab.html
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Shdr29 } from "@/components/ui/shdr-29";
import { CLAUDE_WORKING_PARAMS } from "./orbLook";
import { ORB_PULSE_TRANSITION, orbOpacity, orbScale } from "./desktop";

type OrbState = "idle" | "thinking" | "speaking";

function Lab() {
  const [state, setState] = useState<OrbState>("idle");
  const [working, setWorking] = useState(true);
  const [p, setP] = useState({ ...CLAUDE_WORKING_PARAMS });
  const [accentColor, setAccentColor] = useState("#d97757");
  const [grokOff, setGrokOff] = useState(true);
  // "Pulse with your voice" preview: a speech-like level at 20 per second, like the real mic level.
  const [voice, setVoice] = useState(false);
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!voice) return setLevel(0);
    let t = 0;
    let lvl = 0;
    const id = setInterval(() => {
      t += 0.05;
      const syllables = Math.max(0, Math.sin(t * 9) * Math.sin(t * 2.3)); // bursts and pauses
      lvl = Math.max(syllables * (0.6 + 0.4 * Math.random()), lvl * 0.8); // same decay as the app
      setLevel(Math.min(1, lvl));
    }, 50);
    return () => clearInterval(id);
  }, [voice]);
  const pulseStyle = { transform: `scale(${orbScale(level, voice)})`, transition: ORB_PULSE_TRANSITION };
  const dim = orbOpacity({ phase: grokOff ? "off" : "listening", asleep: false, hearing: false, input: 0, claudeWorking: working });
  const set = (k: string, v: number) => setP((x) => ({ ...x, [k]: v }));
  const colors = { accent: accentColor };
  const snippet = `export const CLAUDE_WORKING_PARAMS = { accent: ${p.accent}, confetti: ${p.confetti}, tint: ${p.tint} };${accentColor !== "#d97757" ? `\n// accent colour: ${accentColor}` : ""}`;

  return (
    <div className="min-h-screen bg-black p-6 text-white">
      <h1 className="text-[17px] font-semibold">Orb lab</h1>
      <p className="mt-1 text-[12.5px] text-white/50">How the orb looks while Claude is working. Changes glide, exactly as in Orbit.</p>

      <label className="mt-4 flex items-center gap-2 text-[12.5px] text-white/70">
        <input type="checkbox" checked={grokOff} onChange={(e) => setGrokOff(e.target.checked)} />
        Grok is off (dimmed like in Orbit)
      </label>
      <label className="mt-2 flex items-center gap-2 text-[12.5px] text-white/70">
        <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        Pulse with your voice (simulated speech)
        {voice && <span className="text-white/40 tabular-nums">level {level.toFixed(2)} · size {(orbScale(level, true) * 100).toFixed(1)}%</span>}
      </label>
      <div className="mt-4 flex flex-wrap items-end gap-10">
        <figure className="text-center">
          <div style={{ opacity: orbOpacity({ phase: grokOff ? "off" : "listening", asleep: false, hearing: false, input: 0 }), transition: "opacity .3s" }}>
            <div style={pulseStyle}><Shdr29 size={220} state={state} pauseOffscreen={false} /></div>
          </div>
          <figcaption className="mt-2 text-[12px] text-white/50">Normal</figcaption>
        </figure>
        <figure className="text-center">
          <div style={{ opacity: dim, transition: "opacity .3s" }}>
            <div style={pulseStyle}><Shdr29 size={220} state={state} params={working ? p : undefined} colors={colors} pauseOffscreen={false} /></div>
          </div>
          <figcaption className="mt-2 text-[12px] text-white/50">{working ? "Claude is working" : "Claude is working (off)"}</figcaption>
        </figure>
        <figure className="text-center">
          <div style={{ opacity: dim, transition: "opacity .3s" }}>
            <div style={pulseStyle}><Shdr29 size={96} state={state} params={working ? p : undefined} colors={colors} pauseOffscreen={false} /></div>
          </div>
          <figcaption className="mt-2 text-[12px] text-white/50">Floating orb size</figcaption>
        </figure>
      </div>

      <div className="mt-8 grid max-w-[560px] gap-4">
        <div className="flex gap-2">
          {(["idle", "thinking", "speaking"] as const).map((s) => (
            <button key={s} onClick={() => setState(s)} className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${state === s ? "border-white bg-white text-black" : "border-white/20 text-white/80"}`}>
              {s}
            </button>
          ))}
          <button onClick={() => setWorking((w) => !w)} className={`ml-auto rounded-lg border px-3 py-1.5 text-[12.5px] ${working ? "border-[#d97757] text-[#f0a58b]" : "border-white/20 text-white/80"}`}>
            Claude is working: {working ? "on" : "off"}
          </button>
        </div>
        {[
          ["accent", "Orange in the flowing tiles", 0, 1],
          ["confetti", "How many tiles flow (orb default 0.22)", 0, 0.8],
          ["tint", "Orange tint in the light", 0, 1],
        ].map(([k, label, min, max]) => (
          <label key={k as string} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-[12.5px] text-white/80">
            {label}
            <span className="tabular-nums text-white/50">{p[k as string].toFixed(2)}</span>
            <input type="range" min={min as number} max={max as number} step={0.01} value={p[k as string]} onChange={(e) => set(k as string, Number(e.target.value))} className="col-span-2 accent-[#d97757]" />
          </label>
        ))}
        <label className="flex items-center gap-3 text-[12.5px] text-white/80">
          Accent colour
          <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="h-7 w-12 bg-transparent" />
          <span className="text-white/40">{accentColor}</span>
        </label>
        <pre className="overflow-x-auto rounded-lg border border-white/10 bg-white/[0.04] p-3 text-[12px] text-white/70 select-text">{snippet}</pre>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
);
