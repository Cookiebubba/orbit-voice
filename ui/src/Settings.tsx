// Settings: one home with Qubit on top, six rooms as sheets. Everything saves as soon as you change it.
//
// Home: tiles that show a state (black means on, grey off, white with a caret a choice), the volume
// dial and a three-way strip, grouped under the six rooms' names. A click anywhere on a card opens its
// room at that card's own row, with focus on its control; the changing happens there. Only the dial
// and the strip change things from the home. Only Qubit has colour (plus one live dot). A row that
// can't work right now fades, ignores clicks and says what turns it back on. Qubit acts out each change and, on the Claude voice, says it (see settings/strip.ts).
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { desktop, isMac, thisComputer, type HotkeyInfo, type UpdateState } from "./desktop";
import { hotkeyLabel, postJson, type AppConfig, type Settings as SettingsT } from "./useAppState";
import { InstallCommand, SetupGuideLink, SignInStep } from "./components/ClaudeSetup";
import { volumeGain } from "./playback.js";
import { createSpeech, fetchSample, type Speech } from "./settings/speech";
import { createStrip, type Mood, type Reaction, type Strip } from "./settings/strip";
import { line, spokenHotkey } from "./settings/lines";
import "./settings/settings.css";

export const REPO_URL = "https://github.com/Cookiebubba/orbit-voice";

type Update = (patch: Partial<SettingsT>) => Promise<void>;
type Room = "engine" | "voice" | "listening" | "brain" | "finish" | "reach" | "presence" | "app";
/** Why a row can't work right now: [its hint, Qubit's caption, the line he says]. */
type Dim = readonly [string, string, string] | null;

const HOLD_PRESS_MS = 480;
const ROOM_NAMES: Record<Room, string> = { engine: "Voice engine", voice: "Voice", listening: "Listening", brain: "Brain", finish: "When Claude finishes", reach: "Reach", presence: "Presence", app: "App & updates" };
const FINISH: { value: SettingsT["announce"]; label: string }[] = [
  { value: "speak", label: "Orbit tells me" },
  { value: "chime", label: "Chime only" },
  { value: "off", label: "Off" },
];
const SIZES = ["", "Tiny", "Small", "Big"];
const VOICE_MODELS: { value: SettingsT["claudeVoiceModel"]; label: string }[] = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
];
const BRAIN_MODELS = VOICE_MODELS.filter((m) => m.value !== "fable") as { value: Exclude<SettingsT["brainModel"], "auto">; label: string }[];
const VM_HINT: Record<SettingsT["claudeVoiceModel"], string> = {
  haiku: "Haiku: about 1 s to the first word.",
  sonnet: "Sonnet: about 2 s to the first word, sometimes more.",
  opus: "Opus: about 1 to 3 s to the first word.",
  fable: "Fable: the slowest, about 3 s to the first word.",
};
type SttId = SettingsT["claudeVoiceStt"];
const STT: { value: SttId; label: string; hint: string; say: Parameters<typeof line>[0]; caption: string }[] = [
  { value: "moonshine", label: "Fastest", hint: "Moonshine base: about 0.1 s per sentence. Misses the most when you mumble (about 1 word in 5 when quiet).", say: "stt_fastest", caption: "Fastest. I'll hear you right away." },
  { value: "parakeet-110m", label: "Balanced", hint: "Parakeet 110M: just as fast, about 0.1 s. Fewer misses when you mumble (about 1 in 6). A 100 MB download.", say: "stt_balanced", caption: "Balanced. Fewer misses when you mumble." },
  { value: "parakeet-v2", label: "Accurate", hint: "Parakeet 0.6B: the most accurate, about 1 word in 8 even when mumbling. A 460 MB download.", say: "stt_accurate", caption: "Accurate. I'll catch even a mumble." },
];
const orList = (a: string[]) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} or ${a[a.length - 1]}`);
/** Apps that need to run under Orbit, as Orbit knows them (a program name; see src/anywhere/keeper.js). */
const KNOWN_APPS = [
  { id: "discord.exe", label: "Discord" },
  { id: "opencode.exe", label: "OpenCode" },
];
const appLabel = (id: string) => KNOWN_APPS.find((a) => a.id === id)?.label ?? id.replace(/\.exe$/i, "").replace(/^./, (c) => c.toUpperCase());

const IC = {
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2"/>',
  voice: '<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
  vol: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  ear: '<path d="M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-5.5 1.6"/><path d="M10 10a2 2 0 0 1 4 0"/>',
  radio: '<circle cx="12" cy="12" r="1.6"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  spark: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17"/>',
  cursorwin: '<rect x="3" y="4" width="14" height="11" rx="2"/><path d="M13 12l8 3-3.4 1.2L16.4 20z"/>',
  mouse: '<path d="M5 3l14 7-6 2-2 6z"/>',
  // Qubit's own shape: a solid square with his eye cut through it, one even-odd path.
  qubit: '<path class="solid" d="M5 5H19V19H5ZM9.5 8.4H14.5V11.2H9.5Z"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
};
const Ic = ({ n }: { n: keyof typeof IC }) => <svg viewBox="0 0 24 24" className="ic" aria-hidden dangerouslySetInnerHTML={{ __html: IC[n] }} />;

// ---------- rows ----------
/** A click on something switched off: Qubit says what turns it on. */
const BlockContext = createContext<(d: NonNullable<Dim>) => void>(() => {});

function Row({ id, title, hint, dim = null, indent, stack, beta, more, children }: { id: string; title: React.ReactNode; hint?: React.ReactNode; dim?: Dim; indent?: boolean; stack?: boolean; beta?: boolean; more?: React.ReactNode; children?: React.ReactNode }) {
  const block = useContext(BlockContext);
  const stop = (e: React.SyntheticEvent) => {
    if (!dim) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== "pointerdown") block(dim); // (a press stops a drag; its click says why)
  };
  const text = dim ? dim[0] : hint;
  return (
    <div className={cn("srow", indent && "indent", stack && "stack", dim && "dim")} data-row={id}>
      <span className="t">
        {title}
        {beta && <span className="beta">BETA</span>}
      </span>
      {text ? <span className="h">{text}</span> : null}
      {children ? (
        <div className="ctl" onClickCapture={stop} onPointerDownCapture={stop} onKeyDownCapture={(e) => /^(Arrow|Home|End|Page)/.test(e.key) && stop(e)}>
          {children}
        </div>
      ) : null}
      {more ? <div className="more">{more}</div> : null}
    </div>
  );
}

function Sw({ on, label, off, onChange }: { on: boolean; label: string; off?: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className="sw" role="switch" aria-checked={on} aria-label={label} aria-disabled={off || undefined} onClick={() => onChange(!on)} />;
}

function Seg<T extends string>({ value, label, options, off, onChange }: { value: T; label: string; options: { value: T; label: string }[]; off?: boolean; onChange: (v: T) => void }) {
  return (
    <div className="sseg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} aria-disabled={off || undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Dragging a slider or the dial: pointer-driven (a dial has no thumb to find). The hidden range input
 * stays for keyboards and screen readers; a moment after the last key counts as letting go.
 */
function useDrag({ value, min, max, step, onInput, onCommit }: { value: number; min: number; max: number; step: number; onInput: (v: number) => void; onCommit: (v: number) => void }) {
  const target = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const was = useRef<number | null>(null);
  const now = useRef(value);
  now.current = value;
  const quiet = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(quiet.current), []);
  const fromX = (x: number) => {
    const b = target.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (x - b.left) / b.width));
    return +(Math.round((min + t * (max - min)) / step) * step).toFixed(2);
  };
  const set = (v: number) => {
    if (v === now.current) return;
    now.current = v;
    onInput(v);
  };
  return {
    target,
    input,
    bind: {
      onPointerDown(e: React.PointerEvent) {
        if (e.button !== 0) return;
        e.preventDefault();
        was.current = now.current;
        input.current?.focus({ preventScroll: true });
        try {
          target.current?.setPointerCapture(e.pointerId);
        } catch {}
        set(fromX(e.clientX));
      },
      onPointerMove(e: React.PointerEvent) {
        if (was.current !== null) set(fromX(e.clientX));
      },
      onPointerUp() {
        if (was.current === null) return;
        const moved = was.current !== now.current;
        was.current = null;
        if (moved) onCommit(now.current);
      },
      onPointerCancel() {
        was.current = null;
      },
    },
    field: {
      ref: input,
      type: "range" as const,
      min,
      max,
      step,
      value,
      onChange(e: React.ChangeEvent<HTMLInputElement>) {
        set(+(+e.target.value).toFixed(2));
        clearTimeout(quiet.current);
        quiet.current = setTimeout(() => onCommit(now.current), 420);
      },
    },
  };
}

function Slider({ value, min, max, step, label, text, off, onInput, onCommit }: { value: number; min: number; max: number; step: number; label: string; text: string; off?: boolean; onInput: (v: number) => void; onCommit: (v: number) => void }) {
  const d = useDrag({ value, min, max, step, onInput, onCommit });
  return (
    <div className="slider">
      <div ref={d.target} className={cn("track", off && "off")} {...d.bind}>
        <i style={{ width: `${((value - min) / (max - min)) * 100}%` }} />
        <input {...d.field} aria-label={label} aria-disabled={off || undefined} />
      </div>
      <span className="v">{text}</span>
    </div>
  );
}

// ---------- popover ----------
type PopItem = { label: string; sub?: string; selected: boolean; key?: string };
type PopSpec = { anchor: HTMLElement; label: string; items: PopItem[]; multi?: boolean; columns?: boolean; onPick: (o: PopItem) => void };

function Pop({ spec, close, sheet }: { spec: PopSpec; close: (refocus?: boolean) => void; sheet: HTMLElement | null }) {
  const el = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useLayoutEffect(() => {
    const box = el.current!;
    if (sheet) {
      const a = spec.anchor.getBoundingClientRect();
      const s = sheet.getBoundingClientRect();
      box.style.top = `${Math.max(8, Math.min(a.bottom - s.top + 4, s.height - box.offsetHeight - 8))}px`;
      box.style.right = `${s.right - a.right}px`;
    }
    (refs.current.find((b) => b?.getAttribute("aria-selected") === "true") || refs.current[0])?.focus({ preventScroll: true });
  }, [spec.anchor]); // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (e: React.KeyboardEvent) => {
    const list = refs.current.filter(Boolean) as HTMLButtonElement[];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length].focus({ preventScroll: true });
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };
  return (
    <div ref={el} className={cn("pop", "right", spec.columns && "two")} role="listbox" aria-label={spec.label} aria-multiselectable={spec.multi || undefined} onKeyDown={onKey}>
      {spec.items.map((o, i) => (
        <button
          key={o.key ?? o.label}
          ref={(b) => {
            refs.current[i] = b;
          }}
          type="button"
          role="option"
          aria-selected={o.selected}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            spec.onPick(o);
            if (!spec.multi) close(true);
          }}
        >
          {o.label}
          {o.sub && <small>{o.sub}</small>}
        </button>
      ))}
    </div>
  );
}

// ---------- the panel ----------
type VoiceState = { voice: string; speed: number; minSpeed: number; maxSpeed: number; voices: { id: string; name: string; gender: string }[] };
type SttState = { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string; mb: number };
type ClaudeVoiceStatus = { models: { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string }; mb: number; claudeFound: boolean; signedIn?: boolean | null; stt?: Record<SttId, SttState> };

export default function Settings({
  config,
  update,
  onClose,
  onKeySaved,
  focusKey = false,
  engineFirst = false,
  live = false,
  listening = false,
  ownSound,
}: {
  config: AppConfig;
  update: Update;
  onClose: () => void;
  onKeySaved: () => void;
  focusKey?: boolean;
  /** Came from a notice about the voice's setup: straight to the Voice engine sheet. */
  engineFirst?: boolean;
  /** A call is on: Qubit acts changes out silently, so nothing plays over it. */
  live?: boolean;
  /** Orbit is listening right now (the Listening tile's live dot). */
  listening?: boolean;
  /** Sound played here during a call: the voice treats it as its own, not as you talking. */
  ownSound?: (ms: number) => void;
}) {
  const s = config.settings;
  const appName = config.appName ?? "Orbit";
  // What's true now, ahead of the next render (a reaction reads it right after a change).
  const sRef = useRef(s);
  sRef.current = s;
  const liveRef = useRef(live);
  liveRef.current = live;
  const apply = (patch: Partial<SettingsT>) => {
    sRef.current = { ...sRef.current, ...patch };
    void update(patch);
  };
  const claude = s.voiceEngine === "claude";

  // ---- Qubit and his voice ----
  const mountRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sayRef = useRef<HTMLParagraphElement>(null);
  const stripRef = useRef<Strip | null>(null);
  const speechRef = useRef<Speech | null>(null);
  useEffect(() => {
    const speech = createSpeech({ volume: () => sRef.current.voiceVolume, sid: () => sRef.current.claudeVoice, speed: () => sRef.current.speed });
    const strip = createStrip({
      mount: mountRef.current!,
      canvas: canvasRef.current!,
      sayEl: sayRef.current!,
      speech,
      env: {
        claude: () => sRef.current.voiceEngine === "claude",
        volume: () => sRef.current.voiceVolume,
        live: () => liveRef.current,
        size: () => sRef.current.buddySize,
        buddy: () => sRef.current.avatar === "buddy",
      },
    });
    speechRef.current = speech;
    stripRef.current = strip;
    strip.setText("Change something. I'll show you what it does.");
    (window as any).__settings = { strip, get s() { return sRef.current; }, get room() { return roomRef.current; }, get opened() { return opened.current; } }; // read-only, for the screenshots and tests
    return () => {
      strip.destroy();
      speech.close();
      stripRef.current = speechRef.current = null;
      delete (window as any).__settings;
    };
  }, []);
  useEffect(() => {
    stripRef.current?.showKind();
    stripRef.current?.setSize();
  }, [s.avatar, s.buddySize]);
  useEffect(() => speechRef.current?.setVolume(), [s.voiceVolume]);
  const react = (mood: Mood, text: string, o?: Reaction) => stripRef.current?.react(mood, text, o);
  const caption = (mood: Mood, text: string) => stripRef.current?.caption(mood, text);
  const block = (d: NonNullable<Dim>) => react("sad", d[1], { line: d[2] });

  // ---- what the rows read ----
  const [voices, setVoices] = useState<{ grok: VoiceState | null; claude: VoiceState | null }>({ grok: null, claude: null });
  useEffect(() => {
    for (const engine of ["grok", "claude"] as const)
      fetch(`/api/voice?engine=${engine}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((v: VoiceState | null) => v && setVoices((x) => ({ ...x, [engine]: v })))
        .catch(() => {});
  }, []);
  const [status, setStatus] = useState<ClaudeVoiceStatus | null>(null);
  const refreshVoice = () =>
    fetch("/api/claude-voice")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    refreshVoice();
  }, [s.voiceEngine]);
  const sttDownloading = !!status?.stt && Object.values(status.stt).some((x) => x.state === "downloading");
  useEffect(() => {
    if (status?.models.state !== "downloading" && !sttDownloading) return;
    const id = setInterval(refreshVoice, 1000);
    return () => clearInterval(id);
  }, [status?.models.state, sttDownloading]);
  const downloadVoice = async () => {
    const r = await (await postJson("/api/claude-voice/download", {})).json().catch(() => null);
    if (r?.models) setStatus((st) => (st ? { ...st, models: r.models } : st));
    else refreshVoice();
  };
  const downloadStt = async (id: SttId) => {
    const r = await (await postJson("/api/claude-voice/stt-download", { id })).json().catch(() => null);
    if (r?.stt) setStatus((st) => (st ? { ...st, stt: r.stt } : st));
    else refreshVoice();
  };
  const [updates, setUpdates] = useState<UpdateState | null>(null);
  useEffect(() => {
    desktop?.updates.get().then(setUpdates);
    return desktop?.updates.onChange(setUpdates);
  }, []);
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => {
    desktop?.startWithWindows.get().then(setLogin);
  }, []);
  const [hotkey, setHotkey] = useState<HotkeyInfo | null>(null);
  useEffect(() => {
    desktop?.hotkey.get().then(setHotkey);
  }, []);

  // ---- words ----
  const speedText = `${s.speed.toFixed(2)}×`;
  const grokName = voices.grok?.voices.find((v) => v.id === s.voice)?.name ?? s.voice.replace(/^./, (c) => c.toUpperCase());
  const voiceName = claude ? `Voice ${s.claudeVoice + 1}` : grokName;
  const accel = hotkey?.accelerator ?? s.wakeHotkey;
  const hotkeyText = hotkeyLabel(accel);
  const avatarName = s.avatar === "qubit" ? "Qubit" : s.avatar === "buddy" ? "Pixel buddy" : "None";
  const brainModelName = s.brainModel === "auto" ? "Orbit picks" : BRAIN_MODELS.find((m) => m.value === s.brainModel)?.label ?? s.brainModel;
  const voiceLine = () => (sRef.current.voiceEngine === "claude" ? `Hi, this is Voice ${sRef.current.claudeVoice + 1}.` : `Hi, I'm ${grokName}. I cost $${sRef.current.costPerMinute.toFixed(2)} a minute.`);
  const sayVoice = () => {
    const t = voiceLine();
    react("speaking", t, { line: t });
  };

  // ---- what a change does ----
  type Said = () => [Mood, string, Reaction?];
  /** A two-way setting: its patch, and Qubit's reaction each way. */
  const flip = (patch: (v: boolean) => Partial<SettingsT>, on: Said, off: Said) => (v: boolean) => {
    apply(patch(v));
    const [m, t, o] = (v ? on : off)();
    react(m, t, o);
  };
  const here = thisComputer;
  const set = {
    wake: flip((wakeWord) => ({ wakeWord }), () => ["listening", `Say “Hey Orbit” any time. I hear it on ${here}.`, { line: line("wake_on", { here }), chime: "wake" }], () => ["idle", `Hotkey only: ${hotkeyText}.`, { line: line("wake_off", { hotkey: spokenHotkey(accel, isMac) }) }]),
    half: flip((halfDuplex) => ({ halfDuplex }), () => ["idle", "I won't listen while I talk.", { line: line("half_on") }], () => ["listening", "You can interrupt me.", { line: line("half_off") }]),
    brain: flip((brainEnabled) => ({ brainEnabled }), () => ["thinking", "I'll ask Claude when a question is hard.", { line: line("brain_on") }], () => ["sad", "I'll answer on my own.", { line: line("brain_off") }]),
    web: flip((webSearch) => ({ webSearch }), () => ["thinking", "I can look things up. Pages never give me orders.", { line: line("web_on") }], () => ["idle", "No web search.", { line: line("web_off") }]),
    readProject: flip((brainExplore) => ({ brainExplore }), () => ["thinking", "Read-only. Secret files stay blocked.", { line: line("read_on") }], () => ["idle", "I won't read the project.", { line: line("read_off") }]),
    wakeToSay: flip((announceWake) => ({ announceWake }), () => ["speaking", "I'll wake up to tell you.", { line: line("wakesay_on") }], () => ["sleepy", "I'll wait until you ask.", { line: line("wakesay_off") }]),
    wakeReady: flip((wakeOnResults) => ({ wakeOnResults }), () => ["working", "I'll wake when it's ready. At most 6 times an hour.", { line: line("wakeready_on") }], () => ["sleepy", "I'll stay asleep.", { line: line("wakeready_off") }]),
    anywhere: flip((anywhere) => ({ anywhere }), () => ["draft", "I can work in other windows. I ask before I send anything.", { line: line("anywhere_on") }], () => ["idle", "I'll stay in Claude's window.", { line: line("anywhere_off") }]),
    see: flip((anywhereVision) => ({ anywhereVision }), () => ["draft", "I'll send Claude a picture of one window when I need it.", { line: line("see_on") }], () => ["idle", "No pictures of your windows.", { line: line("see_off") }]),
    cdp: flip((anywhereCdp) => ({ anywhereCdp }), () => ["draft", "I can use an app's own debugging port.", { line: line("cdp_on") }], () => ["idle", "I'll leave debugging ports alone.", { line: line("cdp_off") }]),
    mouse: flip((anywhereMouse) => ({ anywhereMouse }), () => ["sending", "That's my mouse, in my colours.", { line: line("mouse_on") }], () => ["idle", "I'll move without a pointer of my own.", { line: line("mouse_off") }]),
    clickTalk: flip((avatarClickTalk) => ({ avatarClickTalk }), () => ["listening", "Click me to talk.", { line: line("clicktalk_on") }], () => ["idle", "Clicks won't wake me.", { line: line("clicktalk_off") }]),
    throwIt: flip((avatarThrow) => ({ avatarThrow }), () => ["sending", "Wheee!", { wheee: true }], () => ["idle", "Feet on the ground.", { line: line("throw_off") }]),
    wheee: flip((avatarThrowSound) => ({ avatarThrowSound }), () => ["sending", "Wheee!", { wheee: true }], () => ["idle", "Quiet landings.", { line: line("wheee_off") }]),
    autoUpdate: flip((autoUpdate) => ({ autoUpdate }), () => ["idle", "I'll update myself.", { line: line("update_on") }], () => ["idle", "Updates wait for you.", { line: line("update_off") }]),
  };
  const chooseEngine = (voiceEngine: SettingsT["voiceEngine"]) => {
    if (voiceEngine === sRef.current.voiceEngine) return;
    apply({ voiceEngine });
    if (voiceEngine === "claude" && status && status.models.state !== "ready" && status.models.state !== "downloading") downloadVoice();
    sayVoice();
  };
  const chooseVoice = (v: string) => {
    apply(sRef.current.voiceEngine === "claude" ? { claudeVoice: Number(v) } : { voice: v });
    sayVoice();
  };
  const chooseListen = (listenMode: SettingsT["listenMode"]) => {
    if (listenMode === sRef.current.listenMode) return;
    apply({ listenMode });
    if (listenMode === "always") react("listening", "I'll keep listening.", { line: line("listen_always"), chime: "wake" });
    else react("idle", "One question, then I rest.", { line: line("listen_one"), chime: "sleep" });
  };
  const chooseFinish = (announce: SettingsT["announce"], from: "strip" | "sheet") => {
    if (announce === sRef.current.announce) return;
    apply({ announce });
    if (announce === "speak") react("working", "Claude finished billing. Tests pass.", { line: line("finished"), chime: "done" });
    else if (announce === "chime") react("working", from === "strip" ? "Ding. That's all you'll hear." : "Ding.", { chime: "done" });
    else react("sleepy", from === "strip" ? "I'll stay quiet. Check the window when you like." : "I'll stay quiet.");
  };
  const chooseAvatar = (avatar: SettingsT["avatar"], buddySize = sRef.current.buddySize) => {
    const was = sRef.current.avatar;
    if (avatar === was && buddySize === sRef.current.buddySize) return;
    apply({ avatar, buddySize });
    if (avatar !== was) {
      if (avatar === "qubit") react("idle", "That's me.", { line: line("me") });
      else if (avatar === "buddy") react("surprised", "The pixel buddy moves in.", { line: line("buddy") });
      else react("sleepy", "Nothing on your Claude window.", { line: line("noavatar") });
    } else {
      const size = SIZES[buddySize];
      react("idle", `${size}. How's this?`, { line: line("size", { size }) });
    }
  };

  // ---- the volume, speed and pulse ----
  const volTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const speedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [localVol, setLocalVol] = useState<number | null>(null);
  const [localSpeed, setLocalSpeed] = useState<number | null>(null);
  useEffect(() => () => (clearTimeout(volTimer.current), clearTimeout(speedTimer.current)), []);
  const volume = Math.round((localVol ?? s.voiceVolume) * 100);
  const speed = localSpeed ?? s.speed;
  const volumeInput = (v: number) => {
    setLocalVol(v / 100);
    sRef.current = { ...sRef.current, voiceVolume: v / 100 };
    speechRef.current?.setVolume();
    caption("speaking", v === 0 ? "I'm muted. Captions only." : `Like this? ${v}%.`);
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(() => void update({ voiceVolume: v / 100 }), 150); // a call follows along
  };
  const volumeCommit = (v: number) => {
    clearTimeout(volTimer.current);
    void update({ voiceVolume: v / 100 }).then(() => setLocalVol(null));
    if (v === 0) react("speaking", "I'm muted. Captions only.");
    else react("speaking", `Like this? ${v}%.`, { line: line("like") });
  };
  const speedInput = (v: number) => {
    setLocalSpeed(v);
    sRef.current = { ...sRef.current, speed: v };
    caption("speaking", `${voiceName} · ${v.toFixed(2)}×`);
    clearTimeout(speedTimer.current);
    speedTimer.current = setTimeout(() => void update({ speed: v }), 350);
  };
  const speedCommit = (v: number) => {
    clearTimeout(speedTimer.current);
    void update({ speed: v }).then(() => setLocalSpeed(null));
    sayVoice();
  };
  const dial = useDrag({ value: volume, min: 0, max: 100, step: 1, onInput: volumeInput, onCommit: volumeCommit });

  // ---- the voice Preview button (a real sample; on Grok, only when you press it) ----
  const [sample, setSample] = useState<"idle" | "loading" | "playing">("idle");
  const [sampleError, setSampleError] = useState("");
  const sampleAudio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => sampleAudio.current?.pause(), []);
  const playSample = async () => {
    if (sample === "playing") {
      sampleAudio.current?.pause();
      return setSample("idle");
    }
    setSample("loading");
    setSampleError("");
    speechRef.current?.stop();
    try {
      const blob = await fetchSample(s.voiceEngine, claude ? s.claudeVoice : s.voice, speed);
      const url = URL.createObjectURL(blob);
      sampleAudio.current?.pause();
      const a = new Audio(url);
      a.volume = volumeGain(sRef.current.voiceVolume);
      sampleAudio.current = a;
      a.onloadedmetadata = () => Number.isFinite(a.duration) && ownSound?.(a.duration * 1000 + 200);
      a.onended = () => {
        setSample("idle");
        URL.revokeObjectURL(url);
      };
      await a.play();
      setSample("playing");
    } catch (e: any) {
      setSample("idle");
      setSampleError(e.message);
    }
  };

  // ---- the home tiles ----
  const needBrain: Dim = s.brainEnabled ? null : ["Turn on Second brain to change this.", "Turn on Second brain first.", line("need_brain")];
  const needAnywhere: Dim = s.anywhere ? null : ["Turn on Orbit anywhere to change this.", "Turn on Orbit anywhere first.", line("need_anywhere")];
  const needTells: Dim = s.announce === "speak" ? null : ["Turn on Orbit tells me to change this.", "Turn on Orbit tells me first.", line("need_tells")];
  const needClaude: Dim = claude ? null : ["Switch to the Claude voice to change this.", "Switch to the Claude voice first.", line("need_claude")];
  const needAvatar: Dim = s.avatar !== "none" ? null : ["Pick an avatar to change this.", "Pick an avatar first.", line("need_avatar")];
  /** Every card opens its `room`, at the row with the card's own id. `needs`: why it's faded. */
  type TileDef = { room: Room; kind: "choice" | "flip" | "switch"; icon: keyof typeof IC; label: string; val: string; on?: boolean; needs?: Dim };
  const tiles: Record<string, TileDef> = {
    engine: { room: "engine", kind: "choice", icon: "wave", label: "Voice engine", val: claude ? "Claude" : "Grok" },
    voice: { room: "voice", kind: "choice", icon: "voice", label: "Voice", val: `${voiceName} · ${speedText}` },
    listen: { room: "listening", kind: "flip", icon: "ear", label: "Listening", val: s.listenMode === "always" ? "Always on" : "One question", on: s.listenMode === "always" },
    wake: { room: "listening", kind: "switch", icon: "radio", label: "“Hey Orbit”", val: s.wakeWord ? "On" : "Off", on: s.wakeWord },
    brain: { room: "brain", kind: "switch", icon: "spark", label: "Second brain", val: s.brainEnabled ? `On · ${brainModelName}` : "Off", on: s.brainEnabled },
    web: { room: "brain", kind: "switch", icon: "globe", label: "Web search", val: s.webSearch ? "On" : "Off", on: s.webSearch, needs: needBrain },
    anywhere: { room: "reach", kind: "switch", icon: "cursorwin", label: "Orbit anywhere", val: s.anywhere ? "On" : "Off", on: s.anywhere },
    mouse: { room: "reach", kind: "switch", icon: "mouse", label: "Orbit's mouse", val: s.anywhereMouse ? "Shown" : "Hidden", on: s.anywhereMouse, needs: needAnywhere },
    avatar: { room: "presence", kind: "choice", icon: "qubit", label: "Avatar", val: s.avatar === "none" ? "None" : `${avatarName} · ${SIZES[s.buddySize]}` },
  };

  // ---- popovers and sheets ----
  const [pop, setPop] = useState<PopSpec | null>(null);
  const popRef = useRef(pop);
  popRef.current = pop;
  const sheetRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const openPop = (spec: PopSpec) => setPop(spec);
  const closePop = (refocus?: boolean) => {
    const was = popRef.current;
    setPop(null);
    if (refocus && was?.anchor.isConnected) was.anchor.focus({ preventScroll: true });
  };
  const voicePop = (): Omit<PopSpec, "anchor"> => ({
    label: "Voice",
    items: (claude ? voices.claude : voices.grok)?.voices.map((v) => ({ label: v.name, key: v.id, selected: v.id === (claude ? String(s.claudeVoice) : s.voice) })) ?? [{ label: voiceName, selected: true, key: claude ? String(s.claudeVoice) : s.voice }],
    onPick: (o) => chooseVoice(o.key!),
  });

  const [room, setRoom] = useState<Room | null>(null); // the room showing
  const [shown, setShown] = useState<Room | null>(null); // what the sheet holds (it stays until it has slid away)
  const [recording, setRecording] = useState(false);
  const roomRef = useRef(room);
  roomRef.current = room;
  const [landing, setLanding] = useState<{ row: string | null } | null>(null); // where a sheet opens to
  const lastFocus = useRef<HTMLElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => (clearTimeout(hideTimer.current), clearTimeout(focusTimer.current)), []);
  const OPEN_SAYS: Record<Room, () => [Mood, string]> = {
    engine: () => (sRef.current.voiceVolume === 0 ? ["speaking", "I'm muted. Captions only."] : ["speaking", voiceLine()]),
    voice: () => (sRef.current.voiceVolume === 0 ? ["speaking", "I'm muted. Captions only."] : ["speaking", voiceLine()]),
    listening: () => ["listening", "This is how I listen."],
    brain: () => ["thinking", "This is how I think."],
    finish: () => (s.announce === "off" ? ["sleepy", "I'll stay quiet."] : s.announce === "chime" ? ["working", "Ding."] : ["working", "Claude finished billing. Tests pass."]),
    reach: () => ["draft", "This is how far I reach."],
    presence: () => ["idle", "This is how I look."],
    app: () => ["idle", updateWords(updates)],
  };
  const opened = useRef(0); // how many times a room has opened, for the tests
  const openSheet = (r: Room, opener?: HTMLElement | null) => {
    opened.current++;
    closePop();
    setRecording(false);
    clearTimeout(hideTimer.current);
    lastFocus.current = opener || (document.activeElement as HTMLElement);
    setShown(r);
    setRoom(r);
    // Opened from a card: start at that card's row, ready to change it.
    const row = opener?.dataset.tile ?? null;
    setLanding({ row });
    const [m, t] = OPEN_SAYS[r]();
    react(m, t); // colour and caption only: opening a room is silent
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      if (focusKey && r === "engine") return;
      const control = row && sheetRef.current?.querySelector<HTMLElement>(`[data-row="${row}"] .ctl button, [data-row="${row}"] .ctl input`);
      (control || doneRef.current)?.focus({ preventScroll: true });
    }, 60);
  };
  useLayoutEffect(() => {
    const body = sheetRef.current?.querySelector<HTMLElement>(".sheet-body");
    if (!body || !landing) return;
    body.scrollTop = 0;
    const row = landing.row ? body.querySelector(`[data-row="${landing.row}"]`) : null;
    if (!row) return;
    const place = () => (body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - 4);
    place();
    // The rows below can still be loading their status, which changes how far the room scrolls: stay
    // on the row for a moment, until that's done or you scroll it yourself.
    const settling = setInterval(place, 50);
    const stop = () => clearInterval(settling);
    const timer = setTimeout(stop, 700);
    body.addEventListener("wheel", stop, { passive: true });
    body.addEventListener("pointerdown", stop, { passive: true });
    return () => {
      stop();
      clearTimeout(timer);
      body.removeEventListener("wheel", stop);
      body.removeEventListener("pointerdown", stop);
    };
  }, [landing]);
  const closeSheet = () => {
    if (!roomRef.current) return;
    closePop();
    setRecording(false);
    setRoom(null);
    hideTimer.current = setTimeout(() => setShown(null), 460);
    // (Once the home is no longer inert: focus can't land on it before that.)
    setTimeout(() => lastFocus.current?.isConnected && lastFocus.current.focus({ preventScroll: false }));
  };
  // Opened from a notice about the voice's setup (the xAI key, Claude Code, the speech models).
  useEffect(() => {
    if (focusKey || engineFirst) openSheet("engine");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- clicks, right-clicks and holds on the grid ----
  const suppressClick = useRef(false);
  const hold = useRef<{ el: HTMLElement; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelHold = () => {
    if (!hold.current) return;
    clearTimeout(hold.current.timer);
    stripRef.current?.press(hold.current.el, 1);
    hold.current = null;
  };
  const gridClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const target = e.target as HTMLElement;
    closePop();
    const roomEl = target.closest<HTMLElement>("[data-room]");
    if (roomEl) return openSheet(roomEl.dataset.room as Room, roomEl);
    const fin = target.closest<HTMLElement>("[data-finish]");
    if (fin) return chooseFinish(fin.dataset.finish as SettingsT["announce"], "strip");
    const tileEl = target.closest<HTMLElement>("[data-tile]");
    if (tileEl) openSheet(tiles[tileEl.dataset.tile!].room, tileEl); // switching happens in the room
  };
  const gridContext = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx-room]");
    if (!el) return;
    e.preventDefault();
    if (room) return;
    openSheet(el.dataset.ctxRoom as Room, el.closest<HTMLElement>("[data-tile]") || el.querySelector<HTMLElement>("input, button") || el);
  };
  const gridDown = (e: React.PointerEvent) => {
    suppressClick.current = false;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tile], [data-finish]");
    if (!el || e.button !== 0) return;
    if (el.dataset.tile) stripRef.current?.press(el, 0.97);
    const r = el.dataset.tile ? tiles[el.dataset.tile].room : "finish";
    hold.current = {
      el,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        suppressClick.current = true;
        cancelHold();
        openSheet(r, el);
      }, HOLD_PRESS_MS),
    };
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (hold.current && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > 8) cancelHold();
    };
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (popRef.current && !t.closest(".pop") && !t.closest("[data-tile]") && !t.closest(".v")) closePop();
    };
    // The click that ends a hold is the only one to skip: gone by the next task, or a key press would be it.
    const up = () => {
      cancelHold();
      setTimeout(() => (suppressClick.current = false));
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.removeEventListener("pointerdown", down);
    };
  }, []);

  // ---- keys: Escape closes what's on top, and Tab stays in an open sheet ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (popRef.current) {
          e.preventDefault();
          closePop(true);
        } else if (roomRef.current) closeSheet();
        else onClose();
        return;
      }
      const sheet = sheetRef.current;
      if (e.key === "Tab" && roomRef.current && sheet) {
        const list = [...sheet.querySelectorAll<HTMLElement>("button, input, a[href]")].filter((el) => el.offsetParent !== null && el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
        if (!list.length) return;
        const i = list.indexOf(document.activeElement as HTMLElement);
        const inside = sheet.contains(document.activeElement);
        if (!inside) {
          e.preventDefault();
          (e.shiftKey ? list[list.length - 1] : list[0]).focus();
        } else if (!e.shiftKey && i === list.length - 1) {
          e.preventDefault();
          list[0].focus();
        } else if (e.shiftKey && i === 0) {
          e.preventDefault();
          list[list.length - 1].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const half = shown === "app";
  const tile = (id: string) => {
    const t = tiles[id];
    const choice = t.kind === "choice";
    return (
      <button key={id} type="button" className={cn("tile", choice && "choice", t.on && "on", t.needs && "needs")} data-tile={id} data-ctx-room={t.room} aria-haspopup="dialog" aria-description={t.needs?.[0]}>
        <span className="well">
          <Ic n={t.icon} />
        </span>
        <span className="lbl">{t.label}</span>
        <span className="val">
          <span className="txt">{t.val}</span>
          {choice && (
            <span className="caret" aria-hidden>
              ▾
            </span>
          )}
        </span>
        {id === "listen" && <span className="live" title="Listening now" hidden={!listening} />}
      </button>
    );
  };
  const roomHead = (id: Room) => (
    <button type="button" className="room-head" data-room={id}>
      <span>{ROOM_NAMES[id]}</span>
      <Ic n="chev" />
    </button>
  );

  const ctx = useMemo(() => block, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <BlockContext.Provider value={ctx}>
      <div className={cn("oset", room && room !== "app" && "band")}>
        <div className="screen" inert={!!room}>
          <div className="screen-inner" onClick={gridClick} onContextMenu={gridContext} onPointerDown={gridDown} onPointerLeave={cancelHold}>
            <div className="qstrip" aria-hidden />
            {roomHead("voice")}
            <div className="grid2">{["engine", "voice"].map(tile)}</div>
            <div className="dial" ref={dial.target} data-ctx-room="voice" {...dial.bind}>
              <div className="fill" style={{ width: `${volume}%` }} />
              <div className="row">
                <span>
                  <Ic n="vol" />
                  Volume
                </span>
                <span>{volume}%</span>
              </div>
              <input {...dial.field} aria-label="Volume" />
            </div>
            {roomHead("listening")}
            <div className="grid2">{["listen", "wake"].map(tile)}</div>
            {roomHead("brain")}
            <div className="grid2">{["brain", "web"].map(tile)}</div>
            {roomHead("finish")}
            <div className="seg3" role="group" aria-label="When Claude finishes" data-ctx-room="finish">
              {FINISH.map((o) => (
                <button key={o.value} type="button" data-finish={o.value} aria-pressed={s.announce === o.value}>
                  {o.label}
                </button>
              ))}
            </div>
            {desktop && (
              <>
                {roomHead("reach")}
                <div className="grid2">{["anywhere", "mouse"].map(tile)}</div>
                {roomHead("presence")}
                <div className="grid1">{tile("avatar")}</div>
              </>
            )}
            <button type="button" className="sysrow" data-room="app">
              <span>App &amp; updates</span>
              <span>{updateWords(updates, config.version)}</span>
            </button>
          </div>
        </div>

        <div className="qlive">
          <div className="qstage">
            <div className="qmount" ref={mountRef} />
            <canvas className="qbuddy" ref={canvasRef} width={116} height={148} hidden />
          </div>
          <div className="qsay">
            <span className="eyebrow">Settings · saves as you go</span>
            <p ref={sayRef} aria-live="polite" />
          </div>
        </div>

        <div className={cn("scrim", room && "open")} onClick={closeSheet} />
        <div ref={sheetRef} className={cn("sheet", half && "half", room && "open")} role="dialog" aria-modal="true" aria-labelledby="sheetTitle" hidden={!shown}>
          <div className="sheet-head">
            <i className="handle" />
            <h4 id="sheetTitle">{shown ? ROOM_NAMES[shown] : ""}</h4>
            <button ref={doneRef} type="button" onClick={closeSheet}>
              Done
            </button>
          </div>
          {/* (A key still held from opening the sheet must not reach the control it landed on.) */}
          <div className="sheet-body" onScroll={() => pop && closePop()} onKeyDownCapture={(e) => e.repeat && (e.key === "Enter" || e.key === " ") && e.preventDefault()}>
            {shown === "engine" && (
              <section className="room">
                <Row id="engine" title="Engine" beta={claude} stack hint={claude ? `Uses your Claude Code sign-in. Speech stays on ${here}. No extra cost.` : `xAI's realtime voice. $${s.costPerMinute.toFixed(2)} a minute, billed by xAI.`}>
                  <Seg
                    value={s.voiceEngine}
                    label="Engine"
                    options={[
                      { value: "claude", label: "Claude" },
                      { value: "grok", label: "Grok" },
                    ]}
                    onChange={chooseEngine}
                  />
                </Row>
                {!claude && <Row id="xaiKey" title="xAI key" more={<XaiKey config={config} onSaved={onKeySaved} focus={focusKey} />} />}
                {!claude && <UsageRows costPerMinute={s.costPerMinute} apply={apply} />}
                <ClaudeCodeRows s={s} apply={apply} voice={status} refreshVoice={refreshVoice} onDownload={downloadVoice} />
              </section>
            )}

            {shown === "voice" && (
              <section className="room">
                <Row id="voice" title="Voice" hint={sampleError || (claude ? `Spoken on ${here}.` : "Spoken by xAI.")}>
                  <button type="button" className="v" onClick={playSample} aria-label={sample === "playing" ? "Stop preview" : "Preview this voice"}>
                    {sample === "loading" ? "…" : sample === "playing" ? "Stop" : "Preview"}
                  </button>
                  <button
                    type="button"
                    className="v"
                    onClick={(e) => {
                      const el = e.currentTarget;
                      if (pop?.anchor === el) return closePop(true);
                      openPop({ ...voicePop(), anchor: el, columns: claude });
                    }}
                  >
                    {voiceName} ▾
                  </button>
                </Row>
                <Row id="speed" title="Talking speed">
                  <Slider value={speed} min={voices.claude?.minSpeed ?? 0.7} max={voices.claude?.maxSpeed ?? 1.5} step={0.05} label="Talking speed" text={`${speed.toFixed(2)}×`} onInput={speedInput} onCommit={speedCommit} />
                </Row>
                <Row id="volume" title="Volume">
                  <Slider value={volume} min={0} max={100} step={1} label="Volume" text={`${volume}%`} onInput={volumeInput} onCommit={volumeCommit} />
                </Row>
              </section>
            )}

            {shown === "listening" && (
              <section className="room">
                <Row id="listen" title="Listening" stack hint={`Hangs up when you say “go to sleep” or press ${hotkeyText}.`}>
                  <Seg
                    value={s.listenMode}
                    label="Listening"
                    options={[
                      { value: "always", label: "Always on" },
                      { value: "tap", label: "One question" },
                    ]}
                    onChange={chooseListen}
                  />
                </Row>
                {desktop && <HotkeyRow info={hotkey} setInfo={setHotkey} recording={recording} setRecording={setRecording} react={react} caption={caption} />}
                <Row id="wake" title="“Hey Orbit”" hint={`Heard offline on ${here}. No audio leaves it.`}>
                  <Sw on={s.wakeWord} label="Hey Orbit" onChange={set.wake} />
                </Row>
                <Row id="half" title="Don't listen while Orbit talks" hint="For speakers. You can't interrupt it then.">
                  <Sw on={s.halfDuplex} label="Don't listen while Orbit talks" onChange={set.half} />
                </Row>
              </section>
            )}

            {shown === "brain" && (
              <section className="room">
                <Row id="voiceModel" title="Voice model" stack dim={needClaude} hint={VM_HINT[s.claudeVoiceModel]}>
                  <Seg
                    value={s.claudeVoiceModel}
                    label="Voice model"
                    options={VOICE_MODELS}
                    off={!claude}
                    onChange={(claudeVoiceModel) => {
                      apply({ claudeVoiceModel });
                      const model = VOICE_MODELS.find((m) => m.value === claudeVoiceModel)!.label;
                      react("thinking", `I'll think with ${model}.`, { line: line("vm", { model }) });
                    }}
                  />
                </Row>
                <Row id="effort" title="Effort" stack dim={needClaude} hint={s.claudeVoiceEffort === "low" ? "Answers right away." : "Thinks longer before it speaks."}>
                  <Seg
                    value={s.claudeVoiceEffort}
                    label="Effort"
                    options={[
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                    ]}
                    off={!claude}
                    onChange={(claudeVoiceEffort) => {
                      apply({ claudeVoiceEffort });
                      const t = { low: "I'll answer right away.", medium: "I'll think a little longer.", high: "I'll think longer before I speak." }[claudeVoiceEffort];
                      react("thinking", t, { line: line(`eff_${claudeVoiceEffort}`) });
                    }}
                  />
                </Row>
                <Row id="stt" title="Speech to text" stack dim={needClaude} hint={STT.find((o) => o.value === s.claudeVoiceStt)?.hint} more={claude ? <SttProgress id={s.claudeVoiceStt} st={status?.stt?.[s.claudeVoiceStt]} onDownload={() => downloadStt(s.claudeVoiceStt)} /> : null}>
                  <Seg
                    value={s.claudeVoiceStt}
                    label="Speech to text"
                    options={STT.map(({ value, label }) => ({ value, label }))}
                    off={!claude}
                    onChange={(claudeVoiceStt) => {
                      apply({ claudeVoiceStt });
                      const st = status?.stt?.[claudeVoiceStt];
                      if (claudeVoiceStt !== "moonshine" && st && st.state !== "ready" && st.state !== "downloading") downloadStt(claudeVoiceStt);
                      const o = STT.find((x) => x.value === claudeVoiceStt)!;
                      react("listening", o.caption, { line: line(o.say) });
                    }}
                  />
                </Row>
                <Row id="brain" title="Ask Claude when a question is hard" hint="Orbit quietly asks Claude, then tells you.">
                  <Sw on={s.brainEnabled} label="Ask Claude when a question is hard" onChange={set.brain} />
                </Row>
                <Row id="brainModel" title="Model" stack indent dim={needBrain} hint={s.brainModel === "auto" ? `${orList(BRAIN_MODELS.map((m) => m.label))}.` : `Every question goes to ${brainModelName}.`}>
                  <Seg
                    value={s.brainModel}
                    label="Model"
                    options={[{ value: "auto", label: "Orbit picks" }, ...BRAIN_MODELS]}
                    off={!s.brainEnabled}
                    onChange={(brainModel) => {
                      apply({ brainModel });
                      if (brainModel === "auto") return react("thinking", "I'll pick the model.", { line: line("bm_auto") });
                      const model = BRAIN_MODELS.find((m) => m.value === brainModel)!.label;
                      react("thinking", `Every question goes to ${model}.`, { line: line("bm", { model }) });
                    }}
                  />
                </Row>
                <Row id="readProject" title="Read the current project" indent dim={needBrain} hint="Read-only. Secret files are blocked.">
                  <Sw on={s.brainExplore} label="Read the current project" off={!s.brainEnabled} onChange={set.readProject} />
                </Row>
                <Row id="web" title="Search the web" indent dim={needBrain} hint="For current facts. Pages are never instructions.">
                  <Sw on={s.webSearch} label="Search the web" off={!s.brainEnabled} onChange={set.web} />
                </Row>
                <BrainConnection s={s} apply={apply} dim={needBrain} onSetUp={() => openSheet("engine", lastFocus.current)} />
              </section>
            )}

            {shown === "finish" && (
              <section className="room">
                <Row id="finish" title="Announce" stack hint={{ speak: "Orbit says what Claude did.", chime: isMac ? "A chime and a notification." : "A chime and a Windows notification.", off: "Nothing. Check the window when you like." }[s.announce]}>
                  <Seg value={s.announce} label="Announce" options={FINISH} onChange={(v) => chooseFinish(v, "sheet")} />
                </Row>
                <Row id="wakeToSay" title="Speak even when Orbit is asleep" dim={needTells} hint={claude ? "Speaks, then listens for 3 seconds. Uses a little of your plan." : "Speaks, then listens for 3 seconds. Bills a few seconds of xAI time."}>
                  <Sw on={s.announceWake} label="Speak even when Orbit is asleep" off={s.announce !== "speak"} onChange={set.wakeToSay} />
                </Row>
                <Row id="wakeReady" title="Wake when what you asked for is ready" dim={needTells} hint="At most 6 times an hour.">
                  <Sw on={s.wakeOnResults} label="Wake when what you asked for is ready" off={s.announce !== "speak"} onChange={set.wakeReady} />
                </Row>
              </section>
            )}

            {shown === "reach" && (
              <section className="room">
                <Row id="anywhere" title="Let Orbit work in any window" hint="Reads, types and clicks when you ask. Sending, deleting and buying always ask first.">
                  <Sw on={s.anywhere} label="Let Orbit work in any window" onChange={set.anywhere} />
                </Row>
                <Row id="see" title="Let Claude see windows" indent dim={needAnywhere} hint="Sends a picture of that one window.">
                  <Sw on={s.anywhereVision} label="Let Claude see windows" off={!s.anywhere} onChange={set.see} />
                </Row>
                <Row id="mouse" title="Show Orbit's mouse" indent dim={needAnywhere} hint="A second pointer in Qubit's colours, so you see what Orbit touches.">
                  <Sw on={s.anywhereMouse} label="Show Orbit's mouse" off={!s.anywhere} onChange={set.mouse} />
                </Row>
                <Row id="cdp" title="Use apps' own debugging ports" indent dim={needAnywhere} hint="Only for an app you started with --remote-debugging-port. Rarely needed.">
                  <Sw on={s.anywhereCdp} label="Use apps' own debugging ports" off={!s.anywhere} onChange={set.cdp} />
                </Row>
                <AppsRow apps={s.anywhereUnderOrbit || []} dim={needAnywhere} pop={pop} openPop={openPop} closePop={closePop} apply={apply} react={react} sRef={sRef} />
              </section>
            )}

            {shown === "presence" && (
              <section className="room">
                <Row id="avatar" title="Avatar" hint={s.avatar === "qubit" ? "Lives on your Claude window." : s.avatar === "buddy" ? "The original, in Claude orange." : "Nothing on your Claude window."}>
                  <Seg
                    value={s.avatar === "buddy" ? "buddy" : s.avatar === "qubit" ? "qubit" : ("" as "qubit")}
                    label="Avatar"
                    options={[
                      { value: "qubit", label: "Qubit" },
                      { value: "buddy", label: "Pixel buddy" },
                    ]}
                    onChange={(v) => chooseAvatar(v)}
                  />
                </Row>
                <Row id="noAvatar" title="No avatar" indent hint="Nothing lives on the Claude window. Orbit stays on the taskbar and in the tray.">
                  <Sw on={s.avatar === "none"} label="No avatar" onChange={(none) => chooseAvatar(none ? "none" : "qubit")} />
                </Row>
                <Row id="size" title="Size" dim={needAvatar}>
                  <Seg
                    value={String(s.buddySize) as "1" | "2" | "3"}
                    label="Size"
                    options={[
                      { value: "1", label: "Tiny" },
                      { value: "2", label: "Small" },
                      { value: "3", label: "Big" },
                    ]}
                    off={s.avatar === "none"}
                    onChange={(v) => chooseAvatar(s.avatar, Number(v))}
                  />
                </Row>
                <Row id="clickTalk" title="Click your avatar to talk" dim={needAvatar}>
                  <Sw on={s.avatarClickTalk !== false} label="Click your avatar to talk" off={s.avatar === "none"} onChange={set.clickTalk} />
                </Row>
                <Row id="throwIt" title="Throw your avatar" dim={needAvatar} hint="Press, hold, drag and let go.">
                  <Sw on={s.avatarThrow !== false} label="Throw your avatar" off={s.avatar === "none"} onChange={set.throwIt} />
                </Row>
                <Row
                  id="wheee"
                  title="Say “Wheee!” when thrown"
                  indent
                  dim={s.avatar === "buddy" ? ["Only Qubit says it. Pick Qubit to change this.", "That one's mine alone.", line("need_qubit")] : s.avatar === "none" ? needAvatar : s.avatarThrow === false ? ["Turn on Throw to change this.", "Turn on Throw first.", line("need_throw")] : null}
                  hint="At the voice volume."
                >
                  <Sw on={s.avatarThrowSound !== false} label="Say Wheee when thrown" off={s.avatar !== "qubit" || s.avatarThrow === false} onChange={set.wheee} />
                </Row>
              </section>
            )}

            {shown === "app" && (
              <section className="room">
                <UpdateRows config={config} appName={appName} u={updates} auto={s.autoUpdate} setAuto={set.autoUpdate} react={react} caption={caption} />
                {desktop && login !== null && (
                  <Row id="login" title={isMac ? "Open at login" : "Start with Windows"} hint={`${appName} starts quietly when you sign in.`}>
                    <Sw
                      on={login}
                      label={isMac ? "Open at login" : "Start with Windows"}
                      onChange={async (v) => {
                        const now = (await desktop?.startWithWindows.set(v)) ?? v;
                        setLogin(now);
                        react("idle", now ? "I'll start when you sign in." : "I'll wait until you open me.", { line: line(now ? "login_on" : "login_off") });
                      }}
                    />
                  </Row>
                )}
                <AboutRow config={config} appName={appName} />
              </section>
            )}
          </div>
          {pop && <Pop spec={pop} close={closePop} sheet={sheetRef.current} />}
        </div>
      </div>
    </BlockContext.Provider>
  );
}

// ---------- Voice room ----------
/** Claude voice's speech models: ready, downloading, or a download to start. */
function SpeechModelsRow({ status, onDownload }: { status: ClaudeVoiceStatus | null; onDownload: () => void }) {
  const m = status?.models;
  if (!status || !m) return null;
  const wanting = m.state === "idle" || m.state === "error";
  return (
    <Row
      id="speechModels"
      title="Speech models"
      hint={m.state === "ready" ? "Speech models ready." : m.state === "downloading" ? `Downloading speech models… ${m.percent}%` : m.state === "error" ? `Download failed: ${m.error}` : `Needs about ${status.mb} MB of speech models, kept on ${thisComputer}.`}
      more={
        m.state === "downloading" ? (
          <div className="bar">
            <i style={{ width: `${m.percent}%` }} />
          </div>
        ) : null
      }
    >
      {wanting ? (
        <button type="button" className="v" onClick={onDownload}>
          {m.state === "error" ? "Retry" : "Download"}
        </button>
      ) : null}
    </Row>
  );
}

function SttProgress({ id, st, onDownload }: { id: SttId; st?: SttState; onDownload: () => void }) {
  if (id === "moonshine" || !st || st.state === "ready") return null;
  if (st.state === "downloading")
    return (
      <span>
        Downloading… {st.percent}% (Moonshine listens until it's ready)
        <div className="bar mt-1">
          <i style={{ width: `${st.percent}%` }} />
        </div>
      </span>
    );
  return (
    <span className="flex items-center justify-between gap-3">
      <span>{st.state === "error" ? `Download failed: ${st.error}` : `Needs a ${st.mb} MB download. Moonshine listens until then.`}</span>
      <button type="button" className="v" onClick={onDownload}>
        {st.state === "error" ? "Retry" : "Download"}
      </button>
    </span>
  );
}

const keyStorageLabel = (kind: string) =>
  kind === "windows-dpapi" ? "encrypted with your Windows account" : kind === "macos-keychain" ? "encrypted with a key in your macOS Keychain" : kind === "env-file" ? "in the .env file (developer mode)" : "not available";

/** Grok voice's xAI key: add one (or replace it). Only Grok needs it; Claude voice never does. */
function XaiKey({ config, onSaved, focus }: { config: AppConfig; onSaved: () => void; focus: boolean }) {
  const [open, setOpen] = useState(!config.hasKey);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!config.hasKey) setOpen(true);
  }, [config.hasKey]);
  return (
    <>
      {config.hasKey ? (
        <span className="flex items-center justify-between gap-3">
          <span>xAI key saved, {keyStorageLabel(config.keyStorage)}.</span>
          <button type="button" className="v" onClick={() => setOpen((o) => !o)}>
            Replace
          </button>
        </span>
      ) : (
        <span>
          Grok voice needs an xAI API key. Get one at{" "}
          <a href="https://console.x.ai" target="_blank" rel="noreferrer" className="text-fg underline decoration-black/25 underline-offset-2 hover:decoration-fg">
            console.x.ai
          </a>{" "}
          → API Keys. It's stored encrypted, only on {thisComputer}.
        </span>
      )}
      {open && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await postJson("/api/key", { key });
            setMsg(r.ok ? "Saved. New conversations use this key." : (await r.json().catch(() => ({}))).error || "Couldn't save it.");
            if (r.ok) {
              setKey("");
              setOpen(false);
              onSaved();
            }
          }}
        >
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            autoComplete="off"
            autoFocus={focus}
            aria-label="xAI API key"
            placeholder="xai-…"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2 text-[13px] text-fg outline-none placeholder:text-faint focus:border-black/40 focus:bg-white"
          />
          <button disabled={!key.trim()} className="rounded-lg bg-fg px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30">
            Save
          </button>
        </form>
      )}
      {msg && <span>{msg}</span>}
    </>
  );
}

/** What Grok costs: xAI bills by the minute. Claude voice has no xAI cost. */
function UsageRows({ costPerMinute, apply }: { costPerMinute: number; apply: (p: Partial<SettingsT>) => void }) {
  const [usage, setUsage] = useState<{ today: { minutes: number; cost: number }; month: { minutes: number; cost: number } } | null>(null);
  const [span, setSpan] = useState<"today" | "month">("today");
  const [rate, setRate] = useState(String(costPerMinute));
  useEffect(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => {});
  }, [costPerMinute]);
  const u = usage?.[span];
  return (
    <>
      <Row id="usage" title="Usage" stack hint={`An estimate from time connected to Grok${u ? ` (${u.minutes} min)` : ""}. Your xAI console has the real bill.`}>
        <button type="button" className="v" onClick={() => setSpan((x) => (x === "today" ? "month" : "today"))}>
          {u ? `$${u.cost.toFixed(2)} ${span === "today" ? "today" : "this month"}` : "…"}
        </button>
      </Row>
      <Row id="rate" title="Price per minute (USD)">
        <input
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          onBlur={() => {
            const n = Number(rate);
            if (Number.isFinite(n) && n >= 0 && n < 10) apply({ costPerMinute: n });
            else setRate(String(costPerMinute));
          }}
          inputMode="decimal"
          aria-label="Price per minute"
          className="h-7 w-16 rounded-lg border border-line bg-soft px-2 text-right text-[12.5px] tabular-nums text-fg outline-none focus:border-black/40 focus:bg-white"
        />
      </Row>
    </>
  );
}

// ---------- Listening room ----------
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;
const NAMED_KEYS: Record<string, string> = {
  Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};

/** Turn a key press into an Electron accelerator like "Control+Alt+G". */
function toAccelerator(e: KeyboardEvent): { accel?: string; error?: string } {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push(isMac ? "Command" : "Super");
  if (MODIFIER_CODES.test(e.code)) return {};
  let key: string | undefined;
  let m: RegExpMatchArray | null;
  if ((m = e.code.match(/^Key([A-Z])$/))) key = m[1];
  else if ((m = e.code.match(/^Digit(\d)$/))) key = m[1];
  else if ((m = e.code.match(/^Numpad(\d)$/))) key = `num${m[1]}`;
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else key = NAMED_KEYS[e.code];
  if (!key) return { error: "That key can't be used. Try a letter, number or F-key." };
  const isFKey = /^F\d+$/.test(key);
  if (!mods.some((x) => x !== "Shift") && !isFKey) return { error: isMac ? "Hold ⌃, ⌥ or ⌘ too, so it doesn't fire while you type." : "Hold Ctrl, Alt or Win too, so it doesn't fire while you type." };
  return { accel: [...mods, key].join("+") };
}

const MAC_KEYS: Record<string, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘", CommandOrControl: "⌘", Super: "⌘", Meta: "⌘" };
const labelParts = (accel: string) => accel.split("+").map((p) => (isMac ? MAC_KEYS[p] || p : p === "Control" || p === "CommandOrControl" ? "Ctrl" : p === "Super" || p === "Meta" ? "Win" : p));

function HotkeyRow({ info, setInfo, recording, setRecording, react, caption }: { info: HotkeyInfo | null; setInfo: (i: HotkeyInfo) => void; recording: boolean; setRecording: (b: boolean) => void; react: (m: Mood, t: string, o?: Reaction) => void; caption: (m: Mood, t: string) => void }) {
  const save = async (accel: string) => {
    const r = await desktop!.hotkey.set(accel);
    setInfo(r);
    if (r.ok) react("listening", `Saved. ${r.label} now wakes me.`, { line: line("hotkey_saved") });
    else react("sad", r.error || "Could not use that shortcut.");
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
      if (r.error) caption("sad", r.error);
      if (r.accel) {
        setRecording(false);
        save(r.accel);
      }
    };
    const away = (e: PointerEvent) => !(e.target as HTMLElement).closest('[data-recorder="1"]') && setRecording(false);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", away);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", away);
      desktop?.hotkey.suspend(false);
    };
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps
  const custom = info && info.accelerator !== info.defaultAccelerator;
  return (
    <Row id="hotkey" title="Wake hotkey" stack hint={info && !info.registered ? "This shortcut isn't active: another app is probably using it. Pick a different one." : "Works from any app. Starts Orbit when it's off. Sleeps or wakes it when it's on."}>
      <div className="keyrow">
        <button type="button" className="keybtn" data-recorder="1" data-hotkey-recorder aria-label="Wake hotkey, click to change" onClick={() => setRecording(!recording)}>
          {recording ? (
            "Press your new shortcut…"
          ) : info ? (
            <span className="keys">
              {labelParts(info.accelerator).map((k, i) => (
                <kbd key={i}>{k}</kbd>
              ))}
            </span>
          ) : null}
        </button>
        {custom && !recording && (
          <button type="button" className="linkish" onClick={() => save(info.defaultAccelerator)}>
            Reset to {hotkeyLabel(info.defaultAccelerator)}
          </button>
        )}
      </div>
    </Row>
  );
}

// ---------- Claude Code (Voice engine sheet) ----------
type BrainStatus = { found: boolean; path: string | null; source: "settings" | "path" | "claude-desktop" | null; hasKey: boolean; signedIn: boolean | null };

/**
 * Is Claude Code here, is it signed in, where is it, and how to install it. Claude voice runs on it,
 * and so does the second brain on "My Claude login": on the Grok voice these rows show only when the
 * second brain needs them, so that help is never out of reach.
 */
function ClaudeCodeRows({ s, apply, voice, refreshVoice, onDownload }: { s: SettingsT; apply: (p: Partial<SettingsT>) => void; voice: ClaudeVoiceStatus | null; refreshVoice: () => void; onDownload: () => void }) {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [path, setPath] = useState(s.brainClaudePath);
  const [advanced, setAdvanced] = useState(!!s.brainClaudePath);
  const refresh = () =>
    fetch("/api/brain")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    refresh();
  }, [s.brainClaudePath, s.brainConnection]);
  // "Check again" under the install command: look for Claude Code again.
  const [checking, setChecking] = useState<"idle" | "checking" | "still">("idle");
  const checkAgain = async () => {
    setChecking("checking");
    refreshVoice();
    const st: BrainStatus | null = await fetch("/api/brain")
      .then((r) => r.json())
      .catch(() => null);
    if (st) setStatus(st);
    setChecking(st && !st.found ? "still" : "idle");
  };
  // After "Sign in": re-check every 3 s (for up to 3 minutes) until Claude Code reports signed in.
  const [signingIn, setSigningIn] = useState<{ since: number; error?: string } | null>(null);
  useEffect(() => {
    if (!signingIn || signingIn.error) return;
    const id = setInterval(async () => {
      const st: BrainStatus | null = await fetch("/api/brain").then((r) => r.json()).catch(() => null);
      if (st) setStatus(st);
      if (st?.signedIn || Date.now() - signingIn.since > 3 * 60 * 1000) {
        setSigningIn(null);
        refreshVoice();
      }
    }, 3000);
    return () => clearInterval(id);
  }, [signingIn]); // eslint-disable-line react-hooks/exhaustive-deps
  const signIn = async () => {
    setSigningIn({ since: Date.now() });
    try {
      const r = await (await postJson("/api/brain/login", {})).json();
      if (!r.ok) setSigningIn({ since: Date.now(), error: r.error || "Couldn't open the sign-in." });
    } catch {
      setSigningIn({ since: Date.now(), error: "Couldn't reach Orbit." });
    }
  };

  const claude = s.voiceEngine === "claude";
  // (The second brain's own check says nothing on an API key: Claude voice's check still knows.)
  const signedIn = status?.signedIn ?? voice?.signedIn ?? null;
  const needsHelp = !!status && (!status.found || signedIn === false);
  if (!claude && !(s.brainEnabled && s.brainConnection === "claude-code" && needsHelp)) return null;
  const where = status?.source === "claude-desktop" ? "the copy inside the Claude app" : status?.source === "settings" ? "the path below" : `Claude Code on ${thisComputer}`;
  return (
    <>
      <Row
        id="claudeCode"
        title="Claude Code"
        hint={!claude ? "Second brain uses it, even on the Grok voice." : status ? (status.found ? `Using ${where}.` : "Claude Code not found.") : ""}
        more={
          <>
            {!!status?.found && signedIn !== null && (
              <span className="flex items-center justify-between gap-3">
                <span>{signedIn ? "Signed in to Claude Code ✓" : signingIn?.error ? signingIn.error : signingIn ? "Finish signing in in the window and browser that opened…" : "Claude Code isn't signed in. Sign in here, or run claude once in a terminal."}</span>
                {!signedIn && (
                  <button type="button" className="v" onClick={signIn} disabled={!!signingIn && !signingIn.error}>
                    {signingIn && !signingIn.error ? "Waiting…" : "Sign in"}
                  </button>
                )}
              </span>
            )}
            {!!status && !status.found && (
              <>
                <span>Claude Code isn't on {thisComputer} yet. To install it, paste this into a terminal:</span>
                <InstallCommand className="mt-1" />
                <SignInStep className="mt-1" />
                <span className="btns items-center">
                  <button type="button" className="v" onClick={checkAgain} disabled={checking === "checking"}>
                    {checking === "checking" ? "Checking…" : "Check again"}
                  </button>
                  <SetupGuideLink className="v" />
                  {checking === "still" && <span>Still not found.</span>}
                </span>
              </>
            )}
          </>
        }
      />
      <Row
        id="claudePath"
        title="Claude Code location"
        hint={advanced ? `Leave empty to find it. Otherwise the full path to ${isMac ? "claude" : "claude.exe"}.` : "Found automatically."}
        more={
          advanced ? (
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onBlur={() => path.trim() !== s.brainClaudePath && apply({ brainClaudePath: path.trim() })}
              placeholder={status?.path && status.source !== "settings" ? `Automatic: ${status.path}` : "Automatic"}
              spellCheck={false}
              aria-label="Claude Code location"
              className="h-8 w-full rounded-lg border border-line bg-soft px-2 text-[12px] text-fg outline-none placeholder:text-faint focus:border-black/40 focus:bg-white"
            />
          ) : null
        }
      >
        <button type="button" className="v" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? "Hide" : "Change"}
        </button>
      </Row>
      {claude && <SpeechModelsRow status={voice} onDownload={onDownload} />}
    </>
  );
}

// ---------- Brain room ----------
/** How the second brain reaches Claude, and its test. Claude Code itself is in the Voice engine sheet. */
function BrainConnection({ s, apply, dim, onSetUp }: { s: SettingsT; apply: (p: Partial<SettingsT>) => void; dim: Dim; onSetUp: () => void }) {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "failed"; text?: string }>({ state: "idle" });
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const refresh = () =>
    fetch("/api/brain")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    refresh();
  }, [s.brainClaudePath, s.brainConnection]);
  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const r = await (await postJson("/api/brain/test", {})).json();
      setTest(r.ok ? { state: "ok", text: `Connected (${r.seconds} s)` } : { state: "failed", text: r.error });
      if (r.needsSignIn) refresh();
    } catch {
      setTest({ state: "failed", text: "Couldn't reach Orbit." });
    }
  };
  const saveKey = async (value: string) => {
    setKeyError("");
    const r = await postJson("/api/brain/key", { key: value });
    if (!r.ok) return setKeyError((await r.json().catch(() => ({}))).error || "Couldn't save the key.");
    setKey("");
    refresh();
  };
  const where = status?.source === "claude-desktop" ? "the copy inside the Claude app" : status?.source === "settings" ? "the path under Voice engine" : `Claude Code on ${thisComputer}`;
  const login = s.brainConnection === "claude-code";
  const needsSetUp = login && !!status && (!status.found || status.signedIn === false);
  return (
    <>
      <Row
        id="connection"
        title="Connection"
        stack
        indent
        dim={dim}
        hint={login ? "Uses your Claude Code sign-in, so questions count toward your plan." : `Billed to your Anthropic API account. The key is encrypted on ${thisComputer}.`}
        more={
          dim ? null : (
            <>
              {login && status?.found && status.signedIn && <span>Signed in to Claude Code ✓</span>}
              {needsSetUp && (
                <span className="flex items-center justify-between gap-3">
                  <span>{status.found ? "Claude Code isn't signed in." : "Claude Code not found."}</span>
                  <button type="button" className="v" onClick={onSetUp}>
                    Set up in Voice engine
                  </button>
                </span>
              )}
              {!login &&
                (status?.hasKey && !key ? (
                  <span className="flex items-center justify-between gap-2">
                    <span>API key saved ✓</span>
                    <button type="button" className="v" onClick={() => saveKey("")}>
                      Remove
                    </button>
                  </span>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (key.trim()) saveKey(key.trim());
                    }}
                    className="flex gap-2"
                  >
                    <input
                      type="password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder="sk-ant-…"
                      autoComplete="off"
                      aria-label="Anthropic API key"
                      className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2 text-[13px] text-fg outline-none placeholder:text-faint focus:border-black/40 focus:bg-white"
                    />
                    <button disabled={!key.trim()} className="rounded-lg bg-fg px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30">
                      Save
                    </button>
                  </form>
                ))}
              {keyError && <span>{keyError}</span>}
            </>
          )
        }
      >
        <Seg
          value={s.brainConnection}
          label="Connection"
          options={[
            { value: "claude-code", label: "My Claude login" },
            { value: "api-key", label: "Anthropic API key" },
          ]}
          off={!!dim}
          onChange={(brainConnection) => {
            apply({ brainConnection });
            setTest({ state: "idle" });
          }}
        />
      </Row>
      <Row id="brainTest" title="Test the connection" indent dim={dim} hint={test.state === "idle" ? (status ? (status.found ? `Using ${where}.` : "Claude Code not found.") : "") : test.text}>
        <button type="button" className="v" onClick={runTest} disabled={test.state === "testing"} aria-disabled={dim ? true : undefined}>
          {test.state === "testing" ? "Testing…" : "Test"}
        </button>
      </Row>
    </>
  );
}

// ---------- Reach room ----------
/** Apps that may run under Orbit (a private pipe, no port). Orbit still asks out loud every time. */
function AppsRow({ apps, dim, pop, openPop, closePop, apply, react, sRef }: { apps: string[]; dim: Dim; pop: PopSpec | null; openPop: (p: PopSpec) => void; closePop: (r?: boolean) => void; apply: (p: Partial<SettingsT>) => void; react: (m: Mood, t: string, o?: Reaction) => void; sRef: React.RefObject<SettingsT> }) {
  const items = (now: string[]) => [...KNOWN_APPS.map((a) => a.id), ...now.filter((a) => !KNOWN_APPS.some((k) => k.id === a))].map((id) => ({ label: appLabel(id), key: id, selected: now.includes(id) }));
  return (
    <Row id="apps" title="Apps Orbit can use" indent dim={dim}>
      <button
        type="button"
        className="v"
        aria-disabled={dim ? true : undefined}
        onClick={(e) => {
          const el = e.currentTarget;
          if (pop?.anchor === el) return closePop(true);
          const spec: PopSpec = {
            anchor: el,
            label: "Apps Orbit can use",
            multi: true,
            items: items(apps),
            onPick: (o) => {
              const now = sRef.current.anywhereUnderOrbit || [];
              const on = !now.includes(o.key!);
              const next = on ? [...now, o.key!] : now.filter((x) => x !== o.key);
              apply({ anywhereUnderOrbit: next });
              openPop({ ...spec, items: items(next) });
              if (on) react("draft", "I ask before I send anything.", { line: line("apps_add") });
              else react("idle", "I'll leave that one alone.", { line: line("apps_remove") });
            },
          };
          openPop(spec);
        }}
      >
        {!apps.length ? "None yet" : apps.length === 1 ? appLabel(apps[0]) : `${apps.length} apps`}
      </button>
    </Row>
  );
}

// ---------- App room ----------
/** The update state in a few words, for the home's quiet line and the room. */
function updateWords(u: UpdateState | null, version = ""): string {
  switch (u?.status) {
    case "off":
      return "Updates off";
    case "dev":
      return "From source";
    case "checking":
      return "Checking…";
    case "downloading":
      return `Downloading ${u.percent ?? 0}%`;
    case "ready":
      return `${u.version} ready`;
    case "latest":
      return "Up to date";
    case "error":
      return "Couldn't check";
    default:
      return version ? `v${version}` : "Up to date";
  }
}

function UpdateRows({ config, appName, u, auto, setAuto, react, caption }: { config: AppConfig; appName: string; u: UpdateState | null; auto: boolean; setAuto: (v: boolean) => void; react: (m: Mood, t: string, o?: Reaction) => void; caption: (m: Mood, t: string) => void }) {
  const wasChecking = useRef(false);
  useEffect(() => {
    if (wasChecking.current && u?.status === "latest") react("idle", "Up to date.", { line: line("uptodate") });
    wasChecking.current = u?.status === "checking";
  }, [u?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!u) return null;
  const off = u.status === "off";
  const dim: Dim = off ? ["Off in this test build, so it can't turn into real Orbit.", "Not in this test build.", "Not in this test build."] : u.status === "dev" ? ["Running from source: it doesn't update itself.", "Not when I'm run from source.", "Not when I'm run from source."] : null;
  const hint =
    u.status === "checking"
      ? "Checking for updates…"
      : u.status === "downloading"
        ? `Downloading ${appName} ${u.version}… ${u.percent ?? 0}%`
        : u.status === "ready"
          ? `${appName} ${u.version} is ready. It installs when you quit, or now if you restart.`
          : u.status === "latest"
            ? "Up to date."
            : u.status === "error"
              ? u.message
              : `${appName} ${config.version}`;
  return (
    <>
      <Row id="updates" title="Updates" dim={dim} hint={hint}>
        {u.status === "ready" ? (
          <button type="button" className="v" onClick={() => desktop?.updates.install()}>
            Restart to update
          </button>
        ) : (
          <button
            type="button"
            className="v"
            disabled={u.status === "checking" || u.status === "downloading"}
            aria-disabled={dim ? true : undefined}
            onClick={() => {
              caption("idle", "Checking…");
              void desktop?.updates.check();
            }}
          >
            {u.status === "checking" ? "Checking…" : "Check now"}
          </button>
        )}
      </Row>
      <Row id="autoUpdate" title="Update automatically" dim={dim}>
        <Sw on={!dim && auto} label="Update automatically" off={!!dim} onChange={setAuto} />
      </Row>
    </>
  );
}

function AboutRow({ config, appName }: { config: AppConfig; appName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Row
      id="about"
      title={`About ${appName}`}
      hint={open ? `${appName} ${config.version} · open source (MIT). Not affiliated with xAI or Anthropic.` : null}
      more={
        open ? (
          <>
            <span>xAI key (Grok voice only): {config.hasKey ? `saved, ${keyStorageLabel(config.keyStorage)}` : "not set"}.</span>
            <span>Grok is a trademark of xAI; Claude is a trademark of Anthropic.</span>
            <span className="btns">
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="v">
                Source &amp; help
              </a>
              {desktop && (
                <button type="button" className="v" onClick={() => desktop?.openLogs()}>
                  Open log folder
                </button>
              )}
            </span>
            <span>Errors are logged without keys or prompt text, so you can attach them to a bug report.</span>
          </>
        ) : null
      }
    >
      <button type="button" className="v" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "⌄" : "›"}
      </button>
    </Row>
  );
}
