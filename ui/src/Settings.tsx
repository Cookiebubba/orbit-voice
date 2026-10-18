// Settings screen. Everything saves as soon as you change it.
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { desktop, type HotkeyInfo } from "./desktop";
import { postJson, type AppConfig, type Settings as SettingsT } from "./useAppState";
import VoiceSettings from "./VoiceSettings";

export const REPO_URL = "https://github.com/Cookiebubba/orbit-voice";

type Update = (patch: Partial<SettingsT>) => Promise<void>;

export default function Settings({ config, update, onClose }: { config: AppConfig; update: Update; onClose: () => void }) {
  const s = config.settings;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
      <button onClick={onClose} className="mb-4 flex items-center gap-1.5 self-start rounded-md py-1 pr-2 text-[13px] text-white/60 hover:text-white">
        <ArrowLeft size={15} /> Back
      </button>
      <h2 className="mb-5 text-[17px] font-semibold tracking-tight">Settings</h2>

      <div className="space-y-3">
        <VoiceSettings />

        <Section title="Listening">
          <Segmented
            value={s.listenMode}
            onChange={(listenMode) => update({ listenMode })}
            options={[
              { value: "always", label: "Always on" },
              { value: "tap", label: "One question at a time" },
            ]}
          />
          <p className="mt-2 text-[12.5px] leading-relaxed text-white/50">
            {s.listenMode === "always"
              ? `Grok hears you until you say "go to sleep" or press ${s.hotkeyLabel}. Then it hangs up, so nothing is billed, until you press ${s.hotkeyLabel}${s.wakeWord ? ' or say “Hey Grok”' : ''} again.`
              : `Press ${s.hotkeyLabel}${s.wakeWord ? ' or say “Hey Grok”' : ''}, ask one question, and Grok hangs up after answering (it waits up to a minute if a prompt needs your yes). Nothing in the background gets picked up.`}
          </p>
          <Toggle
            className="mt-4"
            checked={s.halfDuplex}
            onChange={(halfDuplex) => update({ halfDuplex })}
            label="Don't listen while Grok is talking"
            hint="Turn on if you use speakers instead of headphones, so Grok doesn't hear itself. You can't interrupt it then."
          />
          <Toggle
            className="mt-4"
            checked={s.wakeWord}
            onChange={(wakeWord) => update({ wakeWord })}
            label="Wake word: say “Hey Grok”"
            hint="Starts Grok hands-free after it has gone to sleep. Recognized entirely on this PC by a small offline speech model: no audio leaves your computer and it costs nothing. Each wake starts a fresh conversation."
          />
        </Section>

        <Section title="When Claude finishes">
          <Segmented
            value={s.announce}
            onChange={(announce) => update({ announce })}
            options={[
              { value: "speak", label: "Grok tells me" },
              { value: "chime", label: "Chime only" },
              { value: "off", label: "Off" },
            ]}
          />
          <p className="mt-2 text-[12.5px] leading-relaxed text-white/50">
            {s.announce === "off"
              ? "Orbit won't tell you when Claude finishes."
              : `Orbit watches your recent Claude sessions. When Claude finishes a task you get a chime and a Windows notification${s.announce === "speak" ? ", and if Grok is on, it says what Claude did." : "."}`}
          </p>
        </Section>

        {desktop && <HotkeySection />}

        {desktop && (
          <Section title="App">
            <StartWithWindows />
          </Section>
        )}

        <UsageSection costPerMinute={s.costPerMinute} update={update} />

        <AboutSection config={config} />
      </div>
    </div>
  );
}

// ---------- building blocks ----------
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 text-[14px] font-medium">{title}</div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div role="radiogroup" className="flex rounded-xl border border-white/15 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("flex-1 rounded-[10px] px-2 py-1.5 text-[12.5px] transition-colors", value === o.value ? "bg-white text-black" : "text-white/70 hover:text-white")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; className?: string }) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-white/90">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-snug text-white/45">{hint}</span>}
      </span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-white" : "bg-white/20")}
      >
        <span className={cn("absolute top-0.5 size-4 rounded-full transition-all", checked ? "left-[18px] bg-black" : "left-0.5 bg-white")} />
      </button>
    </div>
  );
}

function StartWithWindows() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    desktop?.startWithWindows.get().then(setOn);
  }, []);
  if (on === null) return null;
  return (
    <Toggle
      checked={on}
      onChange={async (v) => setOn((await desktop?.startWithWindows.set(v)) ?? v)}
      label="Start with Windows"
      hint="Orbit starts quietly as the floating orb when you sign in."
    />
  );
}

// ---------- usage ----------
function UsageSection({ costPerMinute, update }: { costPerMinute: number; update: Update }) {
  const [usage, setUsage] = useState<{ today: { minutes: number; cost: number }; month: { minutes: number; cost: number } } | null>(null);
  const [rate, setRate] = useState(String(costPerMinute));

  useEffect(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => {});
  }, [costPerMinute]);

  const money = (n: number) => `$${n.toFixed(2)}`;
  return (
    <Section title="Usage">
      <div className="grid grid-cols-2 gap-2">
        {(["today", "month"] as const).map((k) => (
          <div key={k} className="rounded-xl bg-white/[0.04] px-3 py-2">
            <div className="text-[11.5px] text-white/45">{k === "today" ? "Today" : "This month"}</div>
            <div className="text-[17px] font-semibold tabular-nums">{usage ? money(usage[k].cost) : "…"}</div>
            <div className="text-[11.5px] text-white/45 tabular-nums">{usage ? `${usage[k].minutes} min connected` : ""}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-snug text-white/45">
        An estimate from time connected to Grok. Your xAI console has the real bill. Orbit hangs up when you say "go to sleep", so sleeping costs nothing.
      </p>
      <label className="mt-3 flex items-center justify-between gap-3 text-[12.5px] text-white/70">
        Price per minute (USD)
        <input
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          onBlur={() => {
            const n = Number(rate);
            if (Number.isFinite(n) && n >= 0 && n < 10) update({ costPerMinute: n });
            else setRate(String(costPerMinute));
          }}
          inputMode="decimal"
          className="h-8 w-20 rounded-lg border border-white/15 bg-black/40 px-2 text-right text-[13px] tabular-nums outline-none select-text focus:border-white/40"
        />
      </label>
    </Section>
  );
}

// ---------- about + key ----------
function AboutSection({ config }: { config: AppConfig }) {
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const storage =
    config.keyStorage === "windows-dpapi" ? "encrypted with your Windows account" : config.keyStorage === "env-file" ? "in the .env file (developer mode)" : "not available";

  return (
    <Section title="About">
      <div className="space-y-1 text-[12.5px] text-white/60">
        <div>Orbit {config.version} · open source (MIT)</div>
        <div>xAI key: {config.hasKey ? `saved, ${storage}` : "not set"}</div>
        <div className="pt-1 text-[11.5px] leading-snug text-white/40">
          Not affiliated with xAI or Anthropic. Grok is a trademark of xAI; Claude is a trademark of Anthropic.
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="rounded-full border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80 hover:border-white/35">
          Source &amp; help
        </a>
        <button onClick={() => setReplacing((r) => !r)} className="rounded-full border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80 hover:border-white/35">
          Replace xAI key
        </button>
        {desktop && (
          <button onClick={() => desktop?.openLogs()} className="rounded-full border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80 hover:border-white/35">
            Open log folder
          </button>
        )}
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-white/40">
        Errors are logged (without keys or prompt text) so you can attach them to a bug report. Grok can read recent ones too. Just ask "what went wrong?"
      </p>
      {replacing && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await postJson("/api/key", { key });
            setMsg(r.ok ? "Saved. New conversations use the new key." : (await r.json().catch(() => ({}))).error || "Couldn't save it.");
            if (r.ok) {
              setKey("");
              setReplacing(false);
            }
          }}
        >
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            autoComplete="off"
            placeholder="xai-…"
            className="h-9 min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2.5 text-[13px] outline-none select-text focus:border-white/40"
          />
          <button disabled={!key.trim()} className="rounded-lg bg-white px-3 text-[13px] font-medium text-black disabled:opacity-30">
            Save
          </button>
        </form>
      )}
      {msg && <p className="mt-2 text-[12px] text-white/60">{msg}</p>}
    </Section>
  );
}

// ---------- wake hotkey (desktop only) ----------
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

const NAMED_KEYS: Record<string, string> = {
  Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};

/** Turn a key press into an Electron accelerator like "Control+Alt+G". */
function toAccelerator(e: KeyboardEvent): { accel?: string; partial: string[]; error?: string } {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (MODIFIER_CODES.test(e.code)) return { partial: mods };

  let key: string | undefined;
  let m: RegExpMatchArray | null;
  if ((m = e.code.match(/^Key([A-Z])$/))) key = m[1];
  else if ((m = e.code.match(/^Digit(\d)$/))) key = m[1];
  else if ((m = e.code.match(/^Numpad(\d)$/))) key = `num${m[1]}`;
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else key = NAMED_KEYS[e.code];
  if (!key) return { partial: mods, error: "That key can't be used. Try a letter, number or F-key." };

  const isFKey = /^F\d+$/.test(key);
  if (!mods.some((x) => x !== "Shift") && !isFKey) return { partial: mods, error: "Hold Ctrl, Alt or Win too, so it doesn't fire while you type." };
  return { accel: [...mods, key].join("+"), partial: mods };
}

const labelParts = (accel: string) =>
  accel.split("+").map((p) => (p === "Control" || p === "CommandOrControl" ? "Ctrl" : p === "Super" || p === "Meta" ? "Win" : p));

function Keys({ parts, dim }: { parts: string[]; dim?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {parts.map((p, i) => (
        <kbd key={i} className={cn("min-w-7 rounded-md border px-2 py-1 text-center font-sans text-[13px] font-medium", dim ? "border-white/15 text-white/40" : "border-white/25 bg-white/[0.08] text-white")}>
          {p}
        </kbd>
      ))}
    </span>
  );
}

function HotkeySection() {
  const [info, setInfo] = useState<HotkeyInfo | null>(null);
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState<string[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    desktop?.hotkey.get().then(setInfo);
  }, []);

  const save = async (accel: string) => {
    const r = await desktop!.hotkey.set(accel);
    setInfo(r);
    setMessage(r.ok ? { text: `Saved. ${r.label} now starts, sleeps and wakes Grok.` } : { text: r.error || "Could not use that shortcut.", bad: true });
  };

  // Record the next shortcut. The current global hotkey is paused meanwhile so it can be re-picked.
  useEffect(() => {
    if (!recording) return;
    desktop?.hotkey.suspend(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) return setRecording(false);
      const r = toAccelerator(e);
      setPartial(r.partial);
      if (r.error) setMessage({ text: r.error, bad: true });
      if (r.accel) {
        setRecording(false);
        save(r.accel);
      }
    };
    const onUp = (e: KeyboardEvent) => setPartial(toAccelerator(e).partial);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      setPartial([]);
      desktop?.hotkey.suspend(false);
    };
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDefault = info && info.accelerator === info.defaultAccelerator;

  return (
    <Section title="Wake hotkey">
      <p className="-mt-1 text-[12.5px] leading-relaxed text-white/50">Works from any app: starts Grok when it's off, and puts it to sleep or wakes it when it's on.</p>
      <button
        data-hotkey-recorder
        onClick={() => {
          setMessage(null);
          setRecording((r) => !r);
        }}
        className={cn("mt-4 flex min-h-12 w-full items-center justify-center rounded-xl border px-3 py-2 transition-colors", recording ? "border-white/60 bg-white/[0.06]" : "border-white/15 hover:border-white/35")}
      >
        {recording ? (
          partial.length ? <Keys parts={labelParts(partial.join("+"))} dim /> : <span className="text-[13px] text-white/70">Press your new shortcut…</span>
        ) : info ? (
          <Keys parts={labelParts(info.accelerator)} />
        ) : null}
      </button>
      <div className="mt-2 flex items-center justify-between text-[12px]">
        <span className="text-white/40">{recording ? "Esc to cancel" : "Click to change"}</span>
        {!isDefault && !recording && info && (
          <button onClick={() => save(info.defaultAccelerator)} className="text-white/60 underline-offset-2 hover:text-white hover:underline">
            Reset to {labelParts(info.defaultAccelerator).join("+")}
          </button>
        )}
      </div>
      {message && <p className={cn("mt-3 text-[12.5px] leading-snug", message.bad ? "text-amber-400" : "text-emerald-400")}>{message.text}</p>}
      {info && !info.registered && !message && (
        <p className="mt-3 text-[12.5px] leading-snug text-amber-400">This shortcut isn't active. Another app is probably using it. Pick a different one.</p>
      )}
    </Section>
  );
}
