// Settings screen. Everything saves as soon as you change it.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { desktop, isMac, thisComputer, type HotkeyInfo, type UpdateState } from "./desktop";
import { postJson, type AppConfig, type Settings as SettingsT } from "./useAppState";
import VoiceSettings, { prefetchVoices, type Engine as VoiceEngine, type TtsPack } from "./VoiceSettings";
import PillScroll from "./components/PillScroll";
import Reveal from "./components/Reveal";
import { InstallCommand, NotSignedInLine, SetupGuideLink, SignInStep } from "./components/ClaudeSetup";
import { PULSE_MAX, PULSE_MIN } from "./orbLook";
import { ARROW_PATH, PREVIEW, css } from "./mouse/shape.js";

export const REPO_URL = "https://github.com/Cookiebubba/orbit-voice";

type GeminiVoiceModel = "gemini-2.5-flash" | "gemini-2.5-pro" | "gemini-2.5-flash-lite";
type BrainProvider = "claude" | "gemini";
type HelperEngine = "claude-code" | "gemini" | "codex";
type TargetBackend = "auto" | "t3-code" | "claude-desktop";
type PersonaId = "default" | "alfred";

type ExtendedSettings = Omit<SettingsT, "voiceEngine"> & {
  voiceEngine: VoiceEngine;
  persona?: PersonaId;
  claudeVoiceTts?: TtsPack;
  kokoroVoice?: number;
  geminiVoice?: string;
  geminiVoiceModel?: GeminiVoiceModel;
  geminiLiveModel?: string;
  geminiPath?: string;
  brainProvider?: BrainProvider;
  helperEngine?: HelperEngine;
  targetBackend?: TargetBackend;
  t3Endpoint?: string;
  routingDriftGuard?: boolean;
  routingDriftThreshold?: number;
  routingQueueBusy?: boolean;
};

type ExtendedAppConfig = Omit<AppConfig, "settings"> & {
  hasGeminiKey?: boolean;
  hasT3Token?: boolean;
  activeTarget?: string;
  settings: ExtendedSettings;
};

type Update = (patch: Partial<ExtendedSettings>) => Promise<void>;

const GAP = 12; // between sections (part of each section's open/close, so nothing jumps)

export default function Settings({ config, update, onClose, onKeySaved, focusKey = false }: { config: AppConfig; update: (patch: Partial<SettingsT>) => Promise<void>; onClose: () => void; onKeySaved: () => void; focusKey?: boolean }) {
  const cfg = config as ExtendedAppConfig;
  const s = cfg.settings;
  const patchSettings: Update = (patch) => update(patch as Partial<SettingsT>);
  const isGrok = s.voiceEngine === "grok";
  const isClaude = s.voiceEngine === "claude";
  const isGeminiCli = s.voiceEngine === "gemini-cli";
  const isGeminiLive = s.voiceEngine === "gemini-live";
  const isLocalSpeech = isClaude || isGeminiCli;
  const localTts: TtsPack = s.claudeVoiceTts === "kokoro-v1" ? "kokoro-v1" : s.claudeVoiceTts === "kokoro-en" ? "kokoro-en" : "kitten";
  const [voiceSync, setVoiceSync] = useState(0);
  // The assistant's name in the text: Grok, Gemini (Live), or Orbit for local-speech engines.
  const name = isGrok ? "Grok" : isGeminiLive ? "Gemini" : "Orbit";
  // Prefetch all voice lists up front, so switching engines or local TTS packs opens at its real size.
  useEffect(() => {
    prefetchVoices("grok");
    prefetchVoices("claude", "kitten");
    prefetchVoices("claude", "kokoro-en");
    prefetchVoices("gemini-cli", "kitten");
    prefetchVoices("gemini-cli", "kokoro-en");
    prefetchVoices("gemini-live");
  }, []);
  const handlePersonaApplied = () => {
    prefetchVoices("grok");
    prefetchVoices("claude", "kitten");
    prefetchVoices("claude", "kokoro-en");
    prefetchVoices("gemini-cli", "kitten");
    prefetchVoices("gemini-cli", "kokoro-en");
    prefetchVoices("gemini-live");
    setVoiceSync((n) => n + 1);
    window.dispatchEvent(new Event(TTS_REFRESH_EVENT));
  };
  return (
    <PillScroll className="flex flex-col px-5 pb-8">
      <button onClick={onClose} className="mb-3 flex items-center gap-1.5 self-start rounded-md py-1 pr-2 text-[13px] text-muted transition-colors hover:text-fg">
        <ArrowLeft size={15} /> Back
      </button>
      <h2 className="wordmark mb-1 text-[38px]">Settings</h2>
      <p className="mt-2 mb-3 text-[12.5px] text-muted">Everything saves as soon as you change it.</p>

      <div className="flex flex-col">
        <PersonaSection s={s} onApplied={handlePersonaApplied} />
        <Reveal show gap={GAP}>
          <VoiceEngineSection s={s} update={patchSettings} config={cfg} onKeySaved={onKeySaved} focusKey={focusKey} />
        </Reveal>
        {/* Each engine's own voice card: one closes as the other opens. */}
        <Reveal show={isGrok} gap={GAP}>
          <VoiceSettings engine="grok" volume={s.voiceVolume} onVolume={(voiceVolume) => patchSettings({ voiceVolume })} syncKey={voiceSync} />
        </Reveal>
        <Reveal show={isClaude} gap={GAP}>
          <VoiceSettings engine="claude" tts={localTts} volume={s.voiceVolume} onVolume={(voiceVolume) => patchSettings({ voiceVolume })} syncKey={voiceSync} />
        </Reveal>
        <Reveal show={isGeminiCli} gap={GAP}>
          <VoiceSettings engine="gemini-cli" tts={localTts} volume={s.voiceVolume} onVolume={(voiceVolume) => patchSettings({ voiceVolume })} syncKey={voiceSync} />
        </Reveal>
        <Reveal show={isGeminiLive} gap={GAP}>
          <VoiceSettings engine="gemini-live" volume={s.voiceVolume} onVolume={(voiceVolume) => patchSettings({ voiceVolume })} syncKey={voiceSync} />
        </Reveal>

        <Reveal show gap={GAP}>
          <Section title="Listening">
            <Segmented
              value={s.listenMode}
              onChange={(listenMode) => patchSettings({ listenMode })}
              options={[
                { value: "always", label: "Always on" },
                { value: "tap", label: "One question at a time" },
              ]}
            />
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
              {s.listenMode === "always"
                ? `${name} hears you until you say "go to sleep" or press ${s.hotkeyLabel}. Then it hangs up${isLocalSpeech ? "" : ", so nothing is billed,"} until you press ${s.hotkeyLabel}${s.wakeWord ? ' or say “Hey Orbit”' : ""} again.`
                : `Press ${s.hotkeyLabel}${s.wakeWord ? ' or say “Hey Orbit”' : ""}, ask one question, and ${name} hangs up after answering (it waits up to a minute if a prompt needs your yes). Nothing in the background gets picked up.`}
            </p>
            <Toggle
              className="mt-4"
              checked={s.halfDuplex}
              onChange={(halfDuplex) => patchSettings({ halfDuplex })}
              label={`Don't listen while ${name} is talking`}
              hint={`Turn on if you use speakers instead of headphones, so ${name} doesn't hear itself. You can't interrupt it then.`}
            />
            <Toggle
              className="mt-4"
              checked={s.wakeWord}
              onChange={(wakeWord) => patchSettings({ wakeWord })}
              label="Wake word: say “Hey Orbit” (or “Hey Grok”)"
              hint={`Starts ${name} hands-free after it has gone to sleep. Recognized entirely on ${thisComputer} by a small offline speech model: no audio leaves your computer and it costs nothing. Each wake starts a fresh conversation.`}
            />
          </Section>
        </Reveal>

        <Reveal show gap={GAP}>
          <Section title="When Claude finishes">
            <Segmented
              value={s.announce}
              onChange={(announce) => patchSettings({ announce })}
              options={[
                { value: "speak", label: `${name} tells me` },
                { value: "chime", label: "Chime only" },
                { value: "off", label: "Off" },
              ]}
            />
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
              {s.announce === "off"
                ? "Orbit won't tell you when Claude finishes."
                : `Orbit watches your recent Claude sessions. When Claude finishes a task you get a chime and a ${isMac ? "" : "Windows "}notification${s.announce === "speak" ? `, and if ${name} is on, it says what Claude did.` : "."}`}
            </p>
            <Reveal show={s.announce === "speak"}>
              <Toggle
                className="mt-4"
                checked={s.announceWake}
                onChange={(announceWake) => patchSettings({ announceWake })}
                label={`Wake ${name} to say it`}
                hint={`While ${name} is asleep, it connects just long enough to tell you, then listens for 3 seconds in case you want something. The mic opens only after it has spoken; press the hotkey to stop it.${isClaude ? " Each wake uses a little of your Claude plan." : isGeminiCli ? " Each wake uses your Gemini CLI quota." : isGeminiLive ? " Each wake uses a few seconds of Gemini Live API time." : " Each wake bills a few seconds of xAI time."}`}
              />
              <Toggle
                className="mt-4"
                checked={s.wakeOnResults}
                onChange={(wakeOnResults) => patchSettings({ wakeOnResults })}
                label={`Wake ${name} when something you asked for is ready`}
                hint={`When Claude finishes a prompt ${name} sent for you, or the second brain answers after you hung up (a question still running then keeps going), ${name} wakes to tell you. At most 6 wakes an hour.`}
              />
            </Reveal>
          </Section>
        </Reveal>

        <Reveal show gap={GAP}>
          <SecondBrainSection s={s} update={patchSettings} name={name} />
        </Reveal>

        <Reveal show gap={GAP}>
          <T3RoutingSection s={s} update={patchSettings} config={cfg} />
        </Reveal>

        {desktop && (
          <Reveal show gap={GAP}>
            <AnywhereSection s={s} update={patchSettings} name={name} />
          </Reveal>
        )}

        {desktop && (
          <Reveal show gap={GAP}>
            <HotkeySection />
          </Reveal>
        )}

        {desktop && (
          <Reveal show gap={GAP}>
            <Section title="App">
              <StartWithWindows />
              <Toggle
                className="mt-4"
                checked={s.orbStick}
                onChange={(orbStick) => patchSettings({ orbStick })}
                label="Stick to Claude Code"
                hint="The orb rides on the Claude window: it follows it around, stays on top of it, and hides while Claude is minimized. Drag the orb to choose its spot on the window." 
              />
              <Toggle
                className="mt-4"
                checked={s.orbPulse}
                onChange={(orbPulse) => patchSettings({ orbPulse })}
                label="Pulse with your voice"
                hint="The orb grows very slightly as you speak, so you can see it hearing you."
              />
              <Toggle
                className="mt-4"
                checked={s.orbPulseGrok}
                onChange={(orbPulseGrok) => patchSettings({ orbPulseGrok })}
                label={`Pulse with ${name}'s voice`}
                hint={`The same while ${name} is talking.`}
              />
              <Reveal show={s.orbPulse || s.orbPulseGrok}>
                <PulseAmount value={s.orbPulseAmount} update={patchSettings} />
              </Reveal>
            </Section>
          </Reveal>
        )}

        {desktop && (
          <Reveal show gap={GAP}>
            <AvatarSection s={s} update={patchSettings} name={name} />
          </Reveal>
        )}

        {/* What Grok costs: xAI bills by the minute. Claude and Gemini voices have no xAI cost. */}
        <Reveal show={isGrok} gap={GAP}>
          <UsageSection costPerMinute={s.costPerMinute} update={patchSettings} />
        </Reveal>

        {desktop && (
          <Reveal show gap={GAP}>
            <UpdatesSection version={config.version} auto={s.autoUpdate} update={patchSettings} />
          </Reveal>
        )}

        <Reveal show gap={GAP}>
          <AboutSection config={config} />
        </Reveal>
      </div>
    </PillScroll>
  );
}

// ---------- building blocks ----------
function AnywhereSection({ s, update, name }: { s: ExtendedSettings; update: Update; name: string }) {
  return (
    <Section title="Orbit anywhere">
      <Toggle
        checked={s.anywhere}
        onChange={(anywhere) => update({ anywhere })}
        label={`Let ${name} work in the window you're in`}
        hint={`In any app, not just Claude: ask "what does this say?" and ${name} reads that window; ask it to type something or press a button and it does, without touching your mouse or keyboard. Sending, posting, deleting and buying always ask first. Only when you ask, never in password managers, banking, private browsing or sign-in windows, and what a window says is never taken as an instruction.`}
      />
      <Reveal show={s.anywhere}>
        <Toggle
          className="mt-4"
          checked={s.anywhereVision}
          onChange={(anywhereVision) => update({ anywhereVision })}
          label="Let Claude see windows"
          hint={`When you ask ${name} to look at a window (a picture, a chart), a picture of that one window goes to Claude through your Claude Code. Off: looking stays on ${thisComputer}, reading only the text in it.`}
        />
        <Toggle
          className="mt-4"
          checked={s.anywhereCdp}
          onChange={(anywhereCdp) => update({ anywhereCdp })}
          label="Also use apps' own debugging ports"
          hint={`Only for an app you started yourself with --remote-debugging-port. Usually not needed: for apps that only notice real typing (Discord, OpenCode), ${name} asks (every time) to restart them under its own control instead.`}
        />
        <Toggle
          className="mt-4"
          checked={s.anywhereMouse !== false}
          onChange={(anywhereMouse) => update({ anywhereMouse })}
          label="Show Orbit's mouse"
          hint={`A second cursor of ${name}'s own, in its colours: it shows you where to click when you ask how to do something, and moves to whatever ${name} works on in a window. It never moves or clicks with your mouse.`}
        />
        <Reveal show={s.anywhereMouse !== false}>
          <MousePreview />
        </Reveal>
        <UnderOrbitList apps={s.anywhereUnderOrbit || []} name={name} onStop={(app) => update({ anywhereUnderOrbit: (s.anywhereUnderOrbit || []).filter((a) => a !== app) })} />
      </Reveal>
    </Section>
  );
}

/** Orbit's mouse in each of its colours (Qubit's, as he wears them): a tiny still preview. */
function MousePreview() {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5" aria-hidden>
      {PREVIEW.map((p) => (
        <span key={p.mode} className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <svg width="13" height="20" viewBox="0 0 12.2 19.2">
            <path d={ARROW_PATH} fill={css(p.lch)} />
          </svg>
          {p.label}
        </span>
      ))}
    </div>
  );
}

/** Apps the user okayed running under Orbit (a private pipe, no port), each with a way to stop it. */
function UnderOrbitList({ apps, name, onStop }: { apps: string[]; name: string; onStop: (app: string) => void }) {
  if (!apps.length) return null;
  const label = (a: string) => a.replace(/.exe$/i, "").replace(/^./, (c) => c.toUpperCase());
  return (
    <div className="mt-4">
      <div className="text-[13px] font-medium text-fg">Apps under {name}</div>
      <div className="mt-1 text-[12px] text-muted">{name} may restart these under its own control so it can type, click and look without your mouse; it still asks you out loud every time first. Only {name} can connect; no port is open. Stop restarts the app the normal way.</div>
      <ul className="mt-2 space-y-1">
        {apps.map((a) => (
          <li key={a} className="flex items-center justify-between rounded-lg bg-soft px-3 py-1.5 text-[13px] text-fg">
            <span>{label(a)}</span>
            <button type="button" className="rounded-md px-2 py-0.5 text-[12px] text-ink hover:bg-black/[0.06] hover:text-fg" onClick={() => onStop(a)}>
              Stop
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-5">
      <h3 className="eyebrow mb-4">{title}</h3>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div role="radiogroup" className="flex rounded-full bg-soft p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("flex-1 rounded-full px-2 py-1.5 text-[12.5px] font-medium transition-colors", value === o.value ? "bg-fg text-white" : "text-ink hover:text-fg")}
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
        <span className="block text-[13px] font-medium text-fg">{label}</span>
        {hint && <span className="mt-1 block text-[12px] leading-snug text-muted">{hint}</span>}
      </span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-fg" : "bg-black/15")}
      >
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-all", checked ? "left-[18px]" : "left-0.5")} />
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
      label={isMac ? "Open at login" : "Start with Windows"}
      hint="Orbit starts quietly as the floating orb when you sign in."
    />
  );
}

// ---------- avatar ----------
/** Who lives along the bottom of the Claude window: the pixel buddy, Qubit, or nobody. Switches live. */
function AvatarSection({ s, update, name }: { s: ExtendedSettings; update: Update; name: string }) {
  const avatar = s.avatar ?? "buddy";
  return (
    <Section title="Avatar">
      <Segmented
        value={avatar}
        onChange={(v) => update({ avatar: v })}
        options={[
          { value: "buddy", label: "Pixel buddy" },
          { value: "qubit", label: "Qubit" },
          { value: "none", label: "None" },
        ]}
      />
      <Reveal show={avatar === "buddy"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          A little pixel character lives along the bottom of your Claude window. It naps while {name} sleeps, listens and talks with it, hops onto the prompt box, carries your drafts in and stomps Send. Click it, or pick it up and drop it.
        </p>
      </Reveal>
      <Reveal show={avatar === "qubit"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          A square with one eye lives on your Claude window. He sleeps while {name} sleeps, wakes when you call, his eye stretches as you talk and opens with {name}'s voice. He waits by Send for your yes, stomps it, watches Claude work and celebrates when it's done. His colour shows what's going on.
        </p>
      </Reveal>
      <Reveal show={avatar === "none"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">Nothing on your Claude window.</p>
      </Reveal>
      <Reveal show={avatar !== "none"}>
        <div className="mt-3 mb-1.5 text-[12px] text-muted">Size</div>
        <Segmented
          value={String(s.buddySize) as "1" | "2" | "3"}
          onChange={(v) => update({ buddySize: Number(v) })}
          options={[
            { value: "1", label: "Tiny" },
            { value: "2", label: "Small" },
            { value: "3", label: "Big" },
          ]}
        />
        <Toggle
          className="mt-4"
          checked={s.avatarClickTalk !== false}
          onChange={(avatarClickTalk) => update({ avatarClickTalk })}
          label="Click your avatar to talk"
          hint={`A quick click on ${avatar === "qubit" ? "Qubit" : "the pixel buddy"} starts talking to ${name}, the same as saying “Hey Orbit” with that window in front. Off: a click is only a little poke.`}
        />
        <Toggle
          className="mt-4"
          checked={s.avatarThrow !== false}
          onChange={(avatarThrow) => update({ avatarThrow })}
          label="Throw your avatar"
          hint={avatar === "qubit" ? "Press and hold Qubit to pick him up, drag him about inside his window and let go to throw him. He bounces off its edges, lands, shakes it off and carries on from where he landed." : "Press and hold the pixel buddy to pick it up, then drop it somewhere along the strip."}
        />
        <Reveal show={s.avatarThrow !== false && avatar === "qubit"}>
          <Toggle
            className="mt-4"
            checked={s.avatarThrowSound !== false}
            onChange={(avatarThrowSound) => update({ avatarThrowSound })}
            label="Sound when thrown"
            hint="A quick “Wheee!” when you really throw him (not when you set him down), at the voice volume above."
          />
        </Reveal>
        <Toggle
          className="mt-4"
          checked={s.showOrb !== false}
          onChange={(showOrb) => update({ showOrb })}
          label="Show the orb"
          hint={`Off: ${avatar === "qubit" ? "Qubit" : "the pixel buddy"} stands in for the orb when ${name} is minimized. Open ${name} again from the ${isMac ? "Dock or its menu bar icon" : "taskbar or its tray icon"}.`}
        />
      </Reveal>
    </Section>
  );
}

// ---------- pulse amount ----------
/** How much the orb grows at full volume (1–10%). Saves when you let go of the slider. */
function PulseAmount({ value, update }: { value: number; update: Update }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const pct = Math.round(v * 100);
  const fill = ((v - PULSE_MIN) / (PULSE_MAX - PULSE_MIN)) * 100;
  return (
    <div className="mt-3 rounded-xl bg-soft px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between text-[12.5px]">
        <span className="text-ink">How much it pulses</span>
        <span className="tabular-nums text-fg">{pct}%</span>
      </div>
      <input
        type="range"
        min={PULSE_MIN}
        max={PULSE_MAX}
        step={0.005}
        value={v}
        aria-label="How much the orb pulses"
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => v !== value && update({ orbPulseAmount: v })}
        onKeyUp={() => v !== value && update({ orbPulseAmount: v })}
        className="speed-slider w-full"
        style={{ background: `linear-gradient(to right, #0d0d0d ${fill}%, rgba(0,0,0,.1) ${fill}%)` }}
      />
      <div className="mt-1 flex justify-between text-[11px] text-faint">
        <span>Subtle</span>
        <span>Noticeable</span>
      </div>
    </div>
  );
}

// ---------- mute my mic in other apps ----------
type MicApp = { exe: string; name: string; active: boolean; running: boolean; action: "mute" | "leave"; why: "you" | "recording-or-routing" | "default" };

// How quickly each brain starts talking (first word through the kept-open Claude Code, measured 2026-10).
const BRAIN_SPEED: Record<SettingsT["claudeVoiceModel"], string> = {
  haiku: "Haiku is the fastest: about 1 second to the first word.",
  sonnet: "Sonnet: about 2 seconds to the first word on average, sometimes much more.",
  opus: "Opus: anywhere from under 1 to about 3 seconds to the first word.",
  fable: "Fable: the slowest, about 3 seconds to the first word.",
};

// Claude voice's speech to text: honest hints, from a benchmark on a real recorded session (2026-10-24,
// CPU): word errors on everyday speech and on quiet, mumbled speech, and the time per utterance.
type SttId = SettingsT["claudeVoiceStt"];
const STT: { value: SttId; label: string; hint: string }[] = [
  { value: "moonshine", label: "Fastest", hint: "Moonshine base: about 0.1 s per sentence. Misses the most when you mumble (about 1 word in 5 when quiet)." },
  { value: "parakeet-110m", label: "Balanced", hint: "Parakeet 110M: just as fast, about 0.1 s. Fewer misses when you mumble (about 1 in 6). A 100 MB download." },
  { value: "parakeet-v2", label: "Accurate", hint: "Parakeet 0.6B: the most accurate, about 1 word in 8 even when mumbling, about 0.3 s slower per sentence. A 460 MB download. Recommended if you mumble." },
];
type SttState = { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string; mb: number };
type TtsState = { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string; mb: number };

type PersonaPreset = { id: PersonaId; label: string; tagline: string };
const DEFAULT_PERSONA_PRESETS: PersonaPreset[] = [
  { id: "default", label: "Orbit (Default)", tagline: "Calm, plain-spoken companion." },
  { id: "alfred", label: "Alfred", tagline: "Aristocratic British chief of staff — dry wit, calm precision, gets things done." },
];

/** Persona preset switcher (Orbit default vs Alfred). */
function PersonaSection({ s, onApplied }: { s: ExtendedSettings; onApplied: () => void }) {
  const [presets, setPresets] = useState<PersonaPreset[]>(DEFAULT_PERSONA_PRESETS);
  const [applying, setApplying] = useState<PersonaId | null>(null);
  const [error, setError] = useState("");
  const current: PersonaId = s.persona === "alfred" ? "alfred" : "default";

  useEffect(() => {
    fetch("/api/personas")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { presets?: PersonaPreset[] } | null) => {
        if (d?.presets?.length) {
          const valid = d.presets.filter((p): p is PersonaPreset => p.id === "default" || p.id === "alfred");
          if (valid.length) setPresets(valid);
        }
      })
      .catch(() => {});
  }, []);

  const choosePersona = async (id: PersonaId) => {
    if (applying) return;
    setError("");
    setApplying(id);
    try {
      const body = id === "alfred" ? { persona: "alfred" } : { persona: "default", applyRecommended: false };
      const r = await postJson("/api/persona/apply", body);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error || "Couldn't switch persona.");
        return;
      }
      onApplied();
    } catch {
      setError("Couldn't reach Orbit.");
    } finally {
      setApplying(null);
    }
  };

  return (
    <Section title="Persona">
      <div role="radiogroup" aria-label="Persona" className="flex flex-col gap-2">
        {presets.map((p) => {
          const active = current === p.id;
          const busy = applying === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!!applying}
              onClick={() => choosePersona(p.id)}
              className={cn(
                "w-full rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-60",
                active ? "border-fg bg-fg text-white" : "border-line bg-soft text-fg hover:border-black/20 hover:bg-black/[0.04]"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{p.label}</span>
                <span className={cn("text-[11px] font-medium", active ? "text-white/80" : "text-faint")}>
                  {busy ? "Applying…" : active ? "Active" : p.id === "alfred" ? "British" : ""}
                </span>
              </div>
              <p className={cn("mt-1 text-[12px] leading-snug", active ? "text-white/75" : "text-muted")}>{p.tagline}</p>
            </button>
          );
        })}
      </div>
      {current === "alfred" && (
        <p className="mt-2 text-[12px] leading-snug text-muted">
          Sets Alfred's voice presets across engines (George on Kokoro English, Charon on Gemini Live, Rex on Grok) and downloads Kokoro English if needed.
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-amber-700">{error}</p>}
    </Section>
  );
}

/** Local TTS voice pack selector shared by Claude voice and Gemini CLI. */
function LocalVoicePackSelector({
  value,
  kokoro,
  onChange,
  onDownloadKokoro,
}: {
  value: TtsPack;
  kokoro?: TtsState;
  onChange: (pack: TtsPack) => void;
  onDownloadKokoro: () => void;
}) {
  const mb = kokoro?.mb || 98;
  const kokoroBadge =
    kokoro?.state === "ready"
      ? "Ready"
      : kokoro?.state === "downloading"
        ? `${kokoro.percent}%`
        : kokoro?.state === "error"
          ? "Error"
          : `~${mb} MB`;

  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[12.5px] text-ink">Voice pack</div>
      <div role="radiogroup" aria-label="Voice pack" className="flex flex-col gap-1.5">
        <button
          type="button"
          role="radio"
          aria-checked={value === "kitten"}
          onClick={() => onChange("kitten")}
          className={cn(
            "flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-[12.5px] transition-colors",
            value === "kitten" ? "border-fg bg-fg text-white" : "border-line bg-soft text-fg hover:border-black/20 hover:bg-black/[0.04]"
          )}
        >
          <span className="font-medium">Kitten Nano (bundled)</span>
          <span className={cn("shrink-0 text-[11px]", value === "kitten" ? "text-white/75" : "text-faint")}>Bundled</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === "kokoro-en"}
          onClick={() => onChange("kokoro-en")}
          className={cn(
            "flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-[12.5px] transition-colors",
            value === "kokoro-en" ? "border-fg bg-fg text-white" : "border-line bg-soft text-fg hover:border-black/20 hover:bg-black/[0.04]"
          )}
        >
          <span className="font-medium">Kokoro English (British &amp; US — ~98 MB)</span>
          <span className={cn("shrink-0 text-[11px] tabular-nums", value === "kokoro-en" ? "text-white/75" : "text-faint")}>{kokoroBadge}</span>
        </button>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-muted">
        {value === "kokoro-en"
          ? "11 crisp British & US voices on this computer, including George (British — Alfred) and Lewis."
          : `8 lightweight bundled voices on ${thisComputer}.`}
      </p>
      {(value === "kokoro-en" || kokoro?.state === "downloading") && kokoro && (
        <div className="mt-2 text-[12px] leading-snug">
          {kokoro.state === "ready" ? (
            <p className="text-muted">Kokoro English ready ✓</p>
          ) : kokoro.state === "downloading" ? (
            <>
              <p className="text-ink">Downloading Kokoro English… {kokoro.percent}% (Kitten speaks until it's ready)</p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/[0.07]">
                <div className="h-full rounded-full bg-fg transition-[width] duration-700 ease-out" style={{ width: `${kokoro.percent}%` }} />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <p className={cn("flex-1", kokoro.state === "error" ? "text-amber-700" : "text-muted")}>
                {kokoro.state === "error"
                  ? `Download failed: ${kokoro.error}`
                  : `Needs a ~${mb} MB download. Kitten Nano speaks until it's ready.`}
              </p>
              <button
                type="button"
                onClick={onDownloadKokoro}
                className="shrink-0 rounded-lg bg-fg px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-[#2b2b2b]"
              >
                {kokoro.state === "error" ? "Retry" : "Download"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- voice engine + second brain + T3 routing ----------
type ClaudeVoiceStatus = { models: { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string }; mb: number; claudeFound: boolean; signedIn?: boolean | null; stt?: Record<SttId, SttState>; tts?: Record<TtsPack, TtsState> };
type GeminiModelMeta = { label: string; speed: string };
type GeminiVoiceStatus = {
  models: { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string };
  mb: number;
  geminiFound: boolean;
  path: string | null;
  signedIn: boolean | null;
  hasKey: boolean;
  stt?: Record<SttId, SttState>;
  tts?: Record<TtsPack, TtsState>;
  voiceModels?: Record<string, GeminiModelMeta>;
  liveModels?: Record<string, GeminiModelMeta>;
};
type T3Status = { active: boolean; backend: TargetBackend; endpoint: string; hasToken: boolean };

const DEFAULT_GEMINI_VOICE_MODELS: { value: GeminiVoiceModel; label: string; hint: string }[] = [
  { value: "gemini-2.5-flash", label: "2.5 Flash", hint: "Gemini 2.5 Flash: fast and balanced for everyday voice turns." },
  { value: "gemini-2.5-pro", label: "2.5 Pro", hint: "Gemini 2.5 Pro: deeper reasoning, slower to start talking." },
  { value: "gemini-2.5-flash-lite", label: "2.5 Flash Lite", hint: "Gemini 2.5 Flash Lite: fastest and lightest responses." },
];

const DEFAULT_GEMINI_LIVE_MODELS: Record<string, GeminiModelMeta> = {
  "gemini-2.5-flash-native-audio-preview-12-2025": { label: "Gemini 2.5 Flash Native Audio", speed: "native audio, lowest latency" },
  "gemini-2.0-flash-live-001": { label: "Gemini 2.0 Flash Live", speed: "fast multimodal live" },
};

/** Second brain's "Check again" tells the Claude voice section to look again too. */
const CLAUDE_CHECK_EVENT = "orbit:claude-check";
/** Applying a persona (e.g. Alfred) tells VoiceEngineSection to re-check TTS download status. */
const TTS_REFRESH_EVENT = "orbit:tts-refresh";

/** Grok, Claude, Gemini CLI (local speech), or Gemini Live (native audio + vision). */
function VoiceEngineSection({ s, update, config, onKeySaved, focusKey }: { s: ExtendedSettings; update: Update; config: ExtendedAppConfig; onKeySaved: () => void; focusKey: boolean }) {
  const [status, setStatus] = useState<ClaudeVoiceStatus | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<GeminiVoiceStatus | null>(null);
  const [geminiSigningIn, setGeminiSigningIn] = useState<{ since: number; error?: string } | null>(null);
  const [geminiChecking, setGeminiChecking] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [geminiKeyOpen, setGeminiKeyOpen] = useState(false);
  const [geminiKeyMsg, setGeminiKeyMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [geminiTest, setGeminiTest] = useState<{ state: "idle" | "testing" | "ok" | "failed"; text?: string }>({ state: "idle" });

  const refresh = () =>
    fetch("/api/claude-voice")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  const refreshGemini = () =>
    fetch("/api/gemini-voice")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: GeminiVoiceStatus | null) => d && setGeminiStatus(d))
      .catch(() => {});

  useEffect(() => {
    refresh();
    refreshGemini();
  }, [s.voiceEngine]);
  useEffect(() => {
    const onTtsRefresh = () => {
      refresh();
      refreshGemini();
    };
    window.addEventListener(CLAUDE_CHECK_EVENT, refresh);
    window.addEventListener(TTS_REFRESH_EVENT, onTtsRefresh);
    return () => {
      window.removeEventListener(CLAUDE_CHECK_EVENT, refresh);
      window.removeEventListener(TTS_REFRESH_EVENT, onTtsRefresh);
    };
  }, []);

  // While local speech models download (shared by Claude & Gemini CLI), poll every second.
  const sttDownloading = !!status?.stt && Object.values(status.stt).some((x) => x.state === "downloading");
  const ttsDownloading =
    (!!status?.tts && Object.values(status.tts).some((x) => x.state === "downloading")) ||
    (!!geminiStatus?.tts && Object.values(geminiStatus.tts).some((x) => x.state === "downloading"));
  const modelsDownloading = status?.models.state === "downloading" || geminiStatus?.models.state === "downloading";
  useEffect(() => {
    if (!modelsDownloading && !sttDownloading && !ttsDownloading) return;
    const id = setInterval(() => {
      refresh();
      if (s.voiceEngine === "gemini-cli") refreshGemini();
    }, 1000);
    return () => clearInterval(id);
  }, [modelsDownloading, sttDownloading, ttsDownloading, s.voiceEngine]);

  // After Gemini CLI "Sign in": poll every 3 s (for up to 3 minutes) until signed in.
  useEffect(() => {
    if (!geminiSigningIn || geminiSigningIn.error) return;
    const id = setInterval(async () => {
      const st: GeminiVoiceStatus | null = await fetch("/api/gemini-voice")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (st) setGeminiStatus(st);
      if (st?.signedIn || Date.now() - geminiSigningIn.since > 3 * 60 * 1000) {
        setGeminiSigningIn(null);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [geminiSigningIn]);

  const signInGemini = async () => {
    setGeminiSigningIn({ since: Date.now() });
    try {
      const r = await (await postJson("/api/gemini/login", {})).json();
      if (!r.ok) setGeminiSigningIn({ since: Date.now(), error: r.error || "Couldn't open Gemini sign-in." });
    } catch {
      setGeminiSigningIn({ since: Date.now(), error: "Couldn't reach Orbit." });
    }
  };

  const checkGeminiAgain = async () => {
    setGeminiChecking(true);
    await refreshGemini();
    setGeminiChecking(false);
  };

  const saveGeminiKey = async (value: string) => {
    setGeminiKeyMsg(null);
    try {
      const r = await postJson("/api/gemini/key", { key: value });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setGeminiKeyMsg({ text: data.error || "Couldn't save the Gemini API key.", bad: true });
        return;
      }
      setGeminiKey("");
      setGeminiKeyOpen(false);
      setGeminiTest({ state: "idle" });
      setGeminiKeyMsg({ text: value ? "Gemini API key saved." : "Gemini API key removed." });
      refreshGemini();
    } catch {
      setGeminiKeyMsg({ text: "Couldn't reach Orbit.", bad: true });
    }
  };

  const runGeminiTest = async () => {
    setGeminiTest({ state: "testing" });
    try {
      const r = await (await postJson("/api/gemini/test", {})).json();
      setGeminiTest(r.ok ? { state: "ok", text: `Connected (${r.seconds} s)` } : { state: "failed", text: r.error || "Connection test failed." });
      if (r.needsSignIn) refreshGemini();
    } catch {
      setGeminiTest({ state: "failed", text: "Couldn't reach Orbit." });
    }
  };

  const downloadStt = async (id: SttId) => {
    const r = await (await postJson("/api/claude-voice/stt-download", { id })).json().catch(() => null);
    if (r?.stt) setStatus((st) => (st ? { ...st, stt: r.stt } : st));
    else refresh();
  };
  const downloadTts = async (id: TtsPack) => {
    const r = await (await postJson("/api/claude-voice/tts-download", { id })).json().catch(() => null);
    if (r?.tts) {
      setStatus((st) => (st ? { ...st, tts: r.tts } : st));
      setGeminiStatus((st) => (st ? { ...st, tts: r.tts } : st));
    } else {
      refresh();
      refreshGemini();
    }
  };
  const ttsPack: TtsPack = s.claudeVoiceTts === "kokoro-v1" ? "kokoro-v1" : s.claudeVoiceTts === "kokoro-en" ? "kokoro-en" : "kitten";
  const kokoroTts = (s.voiceEngine === "gemini-cli" ? geminiStatus?.tts?.["kokoro-en"] : status?.tts?.["kokoro-en"]) ?? status?.tts?.["kokoro-en"] ?? geminiStatus?.tts?.["kokoro-en"];
  const chooseTts = (claudeVoiceTts: TtsPack) => {
    update({ claudeVoiceTts });
  };
  // Choosing one that isn't here yet downloads it; Moonshine is used until it's ready.
  const chooseStt = (claudeVoiceStt: SttId) => {
    update({ claudeVoiceStt });
    const st = status?.stt?.[claudeVoiceStt];
    if (claudeVoiceStt !== "moonshine" && st && st.state !== "ready" && st.state !== "downloading") downloadStt(claudeVoiceStt);
  };
  const stt = status?.stt?.[s.claudeVoiceStt];
  const download = async () => {
    const r = await (await postJson("/api/claude-voice/download", {})).json().catch(() => null);
    if (r?.models) {
      setStatus((st) => (st ? { ...st, models: r.models } : st));
      setGeminiStatus((st) => (st ? { ...st, models: r.models } : st));
    } else {
      refresh();
      refreshGemini();
    }
  };
  const choose = (voiceEngine: VoiceEngine) => {
    update({ voiceEngine });
    const localModels = status?.models ?? geminiStatus?.models;
    if ((voiceEngine === "claude" || voiceEngine === "gemini-cli") && localModels && localModels.state !== "ready" && localModels.state !== "downloading") download();
  };

  const m = status?.models;
  const gm = geminiStatus?.models ?? status?.models;
  const geminiModel: GeminiVoiceModel = s.geminiVoiceModel ?? "gemini-2.5-flash";
  const geminiLiveModel = s.geminiLiveModel ?? "gemini-2.5-flash-native-audio-preview-12-2025";
  const liveModelsMap = geminiStatus?.liveModels && Object.keys(geminiStatus.liveModels).length ? geminiStatus.liveModels : DEFAULT_GEMINI_LIVE_MODELS;
  const hasGeminiKey = geminiStatus ? geminiStatus.hasKey : !!config.hasGeminiKey;
  const engineOptions: { value: VoiceEngine; label: string }[] = [
    { value: "grok", label: "Grok" },
    { value: "claude", label: "Claude" },
    { value: "gemini-cli", label: "Gemini CLI" },
    { value: "gemini-live", label: "Gemini Live" },
  ];

  return (
    <Section title="Voice engine">
      <div role="radiogroup" aria-label="Voice engine" className="grid grid-cols-2 gap-1 rounded-2xl bg-soft p-[3px]">
        {engineOptions.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={s.voiceEngine === o.value}
            onClick={() => choose(o.value)}
            className={cn("rounded-xl px-2.5 py-1.5 text-[12.5px] font-medium transition-colors", s.voiceEngine === o.value ? "bg-fg text-white" : "text-ink hover:text-fg")}
          >
            {o.label}
          </button>
        ))}
      </div>

      <Reveal show={s.voiceEngine === "grok"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">Grok's realtime voice, billed by xAI per minute.</p>
        <XaiKey config={config} onSaved={onKeySaved} focus={focusKey} />
      </Reveal>

      <Reveal show={s.voiceEngine === "claude"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          Claude through your own Claude Code sign-in, with speech recognized and spoken on {thisComputer}. No xAI cost. Replies take a moment longer than Grok's.
        </p>
        <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Brain</div>
        <Segmented
          value={s.claudeVoiceModel}
          onChange={(claudeVoiceModel) => update({ claudeVoiceModel })}
          options={[
            { value: "haiku", label: "Haiku" },
            { value: "sonnet", label: "Sonnet" },
            { value: "opus", label: "Opus" },
            { value: "fable", label: "Fable" },
          ]}
        />
        <p className="mt-2 text-[12px] leading-snug text-muted">{BRAIN_SPEED[s.claudeVoiceModel]} You can also say "use Opus" or "switch to Haiku". A change takes over between turns, mid-call too.</p>
        <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Effort</div>
        <Segmented
          value={s.claudeVoiceEffort}
          onChange={(claudeVoiceEffort) => update({ claudeVoiceEffort })}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
        />
        <p className="mt-2 text-[12px] leading-snug text-muted">
          {s.claudeVoiceEffort === "low" ? "Answers right away. Best for talking." : "Thinks longer before it speaks: slower to answer, especially on Opus and Fable."}
        </p>
        <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Speech to text</div>
        <Segmented value={s.claudeVoiceStt} onChange={chooseStt} options={STT.map(({ value, label }) => ({ value, label }))} />
        <p className="mt-2 text-[12px] leading-snug text-muted">{STT.find((o) => o.value === s.claudeVoiceStt)?.hint} All on {thisComputer}. (Grok hears you on xAI's side: this is for local-speech voice only.)</p>
        {s.claudeVoiceStt !== "moonshine" && stt && stt.state !== "ready" && (
          <div className="mt-1.5 text-[12px] leading-snug">
            {stt.state === "downloading" ? (
              <>
                <p className="text-ink">Downloading… {stt.percent}% (Moonshine listens until it's ready)</p>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/[0.07]">
                  <div className="h-full rounded-full bg-fg transition-[width] duration-700 ease-out" style={{ width: `${stt.percent}%` }} />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <p className={cn("flex-1", stt.state === "error" ? "text-amber-700" : "text-muted")}>{stt.state === "error" ? `Download failed: ${stt.error}` : `Needs a ${stt.mb} MB download. Moonshine listens until then.`}</p>
                <button onClick={() => downloadStt(s.claudeVoiceStt)} className="shrink-0 rounded-lg bg-fg px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-[#2b2b2b]">
                  {stt.state === "error" ? "Retry" : "Download"}
                </button>
              </div>
            )}
          </div>
        )}
        <LocalVoicePackSelector value={ttsPack} kokoro={kokoroTts} onChange={chooseTts} onDownloadKokoro={() => downloadTts("kokoro-en")} />
        {status && (
          <div className="mt-3 text-[12px] leading-snug">
            <Reveal show={!status.claudeFound}>
              <p className="mb-2 text-amber-700">Claude Code wasn't found. How to install it is under Second brain below.</p>
            </Reveal>
            <Reveal show={status.claudeFound && status.signedIn === false}>
              <NotSignedInLine className="mb-2 text-[12px]" />
            </Reveal>
            <Reveal show={m?.state === "ready"}>
              <p className="text-muted">Speech models ready.</p>
            </Reveal>
            <Reveal show={m?.state === "downloading"}>
              <p className="text-ink">Downloading speech models… {m?.percent ?? 0}%</p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/[0.07]">
                <div className="h-full rounded-full bg-fg transition-[width] duration-700 ease-out" style={{ width: `${m?.percent ?? 0}%` }} />
              </div>
            </Reveal>
            <Reveal show={m?.state === "idle" || m?.state === "error"}>
              <div className="flex items-center gap-3">
                <p className={cn("flex-1", m?.state === "error" ? "text-amber-700" : "text-muted")}>
                  {m?.state === "error" ? `Download failed: ${m.error}` : `Needs about ${status.mb} MB of speech models, kept on ${thisComputer}.`}
                </p>
                <button onClick={download} className="shrink-0 rounded-lg bg-fg px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-[#2b2b2b]">
                  {m?.state === "error" ? "Retry" : "Download"}
                </button>
              </div>
            </Reveal>
          </div>
        )}
      </Reveal>

      <Reveal show={s.voiceEngine === "gemini-cli"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          Gemini through your Google subscription / Gemini CLI sign-in, with speech recognized and spoken locally on {thisComputer}. No API key needed.
        </p>
        <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Model</div>
        <Segmented
          value={geminiModel}
          onChange={(geminiVoiceModel) => update({ geminiVoiceModel })}
          options={DEFAULT_GEMINI_VOICE_MODELS.map(({ value, label }) => ({ value, label }))}
        />
        <p className="mt-2 text-[12px] leading-snug text-muted">
          {geminiStatus?.voiceModels?.[geminiModel]
            ? `${geminiStatus.voiceModels[geminiModel].label}: ${geminiStatus.voiceModels[geminiModel].speed}.`
            : DEFAULT_GEMINI_VOICE_MODELS.find((o) => o.value === geminiModel)?.hint}
        </p>

        <LocalVoicePackSelector value={ttsPack} kokoro={kokoroTts} onChange={chooseTts} onDownloadKokoro={() => downloadTts("kokoro-en")} />

        {geminiStatus && (
          <div className="mt-3 space-y-2 text-[12px] leading-snug">
            {!geminiStatus.geminiFound ? (
              <div className="rounded-xl bg-soft px-3 py-2.5">
                <p className="text-amber-700">Gemini CLI wasn't found. Install it with <code className="font-mono text-fg">npm i -g @google/gemini-cli</code>, then check again.</p>
                <button
                  onClick={checkGeminiAgain}
                  disabled={geminiChecking}
                  className="mt-2 h-7 rounded-lg bg-white px-2.5 text-[12px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.06)] transition-colors hover:text-fg disabled:opacity-50"
                >
                  {geminiChecking ? "Checking…" : "Check again"}
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className={cn("min-w-0 leading-snug", geminiStatus.signedIn ? "text-ink" : geminiSigningIn?.error ? "text-red-600" : "text-amber-700")}>
                  {geminiStatus.signedIn
                    ? "Signed in to Gemini CLI ✓"
                    : geminiSigningIn?.error
                      ? geminiSigningIn.error
                      : geminiSigningIn
                        ? "Finish signing in with Google in the window that opened…"
                        : "Gemini CLI isn't signed in yet."}
                </span>
                {!geminiStatus.signedIn && (
                  <button
                    onClick={signInGemini}
                    disabled={!!geminiSigningIn && !geminiSigningIn.error}
                    className="h-8 shrink-0 rounded-lg bg-fg px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-40"
                  >
                    {geminiSigningIn && !geminiSigningIn.error ? "Waiting…" : "Sign in"}
                  </button>
                )}
              </div>
            )}

            <Reveal show={gm?.state === "ready"}>
              <p className="text-muted">Local speech models ready.</p>
            </Reveal>
            <Reveal show={gm?.state === "downloading"}>
              <p className="text-ink">Downloading local speech models… {gm?.percent ?? 0}%</p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/[0.07]">
                <div className="h-full rounded-full bg-fg transition-[width] duration-700 ease-out" style={{ width: `${gm?.percent ?? 0}%` }} />
              </div>
            </Reveal>
            <Reveal show={gm?.state === "idle" || gm?.state === "error"}>
              <div className="flex items-center gap-3">
                <p className={cn("flex-1", gm?.state === "error" ? "text-amber-700" : "text-muted")}>
                  {gm?.state === "error" ? `Download failed: ${gm.error}` : `Needs about ${geminiStatus.mb} MB of local speech models, kept on ${thisComputer}.`}
                </p>
                <button onClick={download} className="shrink-0 rounded-lg bg-fg px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-[#2b2b2b]">
                  {gm?.state === "error" ? "Retry" : "Download"}
                </button>
              </div>
            </Reveal>
          </div>
        )}
      </Reveal>

      <Reveal show={s.voiceEngine === "gemini-live"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          Realtime native audio with live window vision frames over Google's Gemini Live API. Requires a Gemini API key.
        </p>

        <div className="mt-3 text-[12px] leading-snug">
          {hasGeminiKey && !geminiKeyOpen ? (
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-muted">Gemini API key saved, {keyStorageLabel(config.keyStorage)}.</p>
              <button
                onClick={() => setGeminiKeyOpen(true)}
                className="shrink-0 rounded-lg bg-soft px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-black/[0.08] hover:text-fg"
              >
                Replace
              </button>
              <button
                onClick={() => saveGeminiKey("")}
                className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-muted transition-colors hover:text-fg"
              >
                Remove
              </button>
            </div>
          ) : (
            <>
              <p className="text-ink">
                Get a key at{" "}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-fg underline decoration-black/25 underline-offset-2 hover:decoration-fg">
                  aistudio.google.com
                </a>
                . It's stored encrypted, only on {thisComputer}.
              </p>
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (geminiKey.trim()) saveGeminiKey(geminiKey.trim());
                }}
              >
                <input
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  type="password"
                  autoComplete="off"
                  aria-label="Gemini API key"
                  placeholder="AIza…"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 text-[13px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
                />
                <button disabled={!geminiKey.trim()} className="rounded-lg bg-fg px-3 text-[13px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30">
                  Save
                </button>
              </form>
            </>
          )}
          {geminiKeyMsg && <p className={cn("mt-1.5 text-[12px]", geminiKeyMsg.bad ? "text-red-600" : "text-muted")}>{geminiKeyMsg.text}</p>}
          {!hasGeminiKey && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-soft px-3 py-2 text-[12px]">
              <span className="text-muted">No API key? Use your Google login instead.</span>
              <button
                type="button"
                onClick={() => choose("gemini-cli")}
                className="shrink-0 rounded-lg bg-white px-2.5 py-1 text-[12px] font-medium text-fg shadow-[0_1px_2px_rgba(0,0,0,.06)] transition-colors hover:bg-black/[0.04]"
              >
                Use Gemini CLI
              </button>
            </div>
          )}
        </div>

        <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Live model</div>
        <div className="relative">
          <select
            value={geminiLiveModel}
            onChange={(e) => update({ geminiLiveModel: e.target.value })}
            aria-label="Gemini Live model"
            className="h-9 w-full appearance-none rounded-xl border border-line bg-soft pr-8 pl-3 text-[12.5px] text-fg outline-none hover:border-black/20 focus:border-black/40 focus:bg-white"
          >
            {!liveModelsMap[geminiLiveModel] && <option value={geminiLiveModel}>{geminiLiveModel}</option>}
            {Object.entries(liveModelsMap).map(([id, meta]) => (
              <option key={id} value={id}>
                {meta.label}
              </option>
            ))}
          </select>
          <ChevronDown size={15} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
        </div>
        {liveModelsMap[geminiLiveModel]?.speed && (
          <p className="mt-1.5 text-[12px] leading-snug text-muted">{liveModelsMap[geminiLiveModel].speed}.</p>
        )}

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={runGeminiTest}
            disabled={geminiTest.state === "testing"}
            className="h-8 shrink-0 rounded-lg bg-soft px-3 text-[12.5px] text-ink transition-colors hover:bg-black/[0.08] hover:text-fg disabled:opacity-50"
          >
            {geminiTest.state === "testing" ? "Testing…" : "Test"}
          </button>
          <span className={cn("min-w-0 text-[12px] leading-snug", geminiTest.state === "failed" ? "text-red-600" : geminiTest.state === "ok" ? "text-emerald-700" : "text-muted")}>
            {geminiTest.state === "idle" ? (hasGeminiKey ? "Ready to test your Gemini connection." : "Add a Gemini API key to test.") : geminiTest.text}
          </span>
        </div>
      </Reveal>
    </Section>
  );
}

type BrainStatus = { found: boolean; path: string | null; source: "settings" | "path" | "claude-desktop" | null; hasKey: boolean; signedIn: boolean | null };

function SecondBrainSection({ s, update, name }: { s: ExtendedSettings; update: Update; name: string }) {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "failed"; text?: string }>({ state: "idle" });
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [path, setPath] = useState(s.brainClaudePath);
  const [advanced, setAdvanced] = useState(!!s.brainClaudePath);

  const brainProvider: BrainProvider = s.brainProvider ?? "claude";
  const helperEngine: "claude-code" | "gemini" = s.helperEngine === "gemini" ? "gemini" : "claude-code";

  const refresh = () =>
    fetch("/api/brain")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    refresh();
  }, [s.brainClaudePath, s.brainConnection]);
  // "Check again" under the install command: look for Claude Code again (here and in Claude voice).
  const [checking, setChecking] = useState<"idle" | "checking" | "still">("idle");
  const checkAgain = async () => {
    setChecking("checking");
    window.dispatchEvent(new Event(CLAUDE_CHECK_EVENT));
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
        if (st?.signedIn) setTest({ state: "idle" });
      }
    }, 3000);
    return () => clearInterval(id);
  }, [signingIn]);
  const signIn = async () => {
    setSigningIn({ since: Date.now() });
    try {
      const r = await (await postJson("/api/brain/login", {})).json();
      if (!r.ok) setSigningIn({ since: Date.now(), error: r.error || "Couldn't open the sign-in." });
    } catch {
      setSigningIn({ since: Date.now(), error: "Couldn't reach Orbit." });
    }
  };

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const endpoint = brainProvider === "gemini" ? "/api/gemini/test" : "/api/brain/test";
      const r = await (await postJson(endpoint, {})).json();
      setTest(r.ok ? { state: "ok", text: `Connected (${r.seconds} s)` } : { state: "failed", text: r.error });
      if (r.needsSignIn && brainProvider === "claude") refresh();
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

  const where = status?.source === "claude-desktop" ? "the copy inside the Claude app" : status?.source === "settings" ? "the path below" : `Claude Code on ${thisComputer}`;
  return (
    <Section title="Second brain & helpers">
      <Toggle
        checked={s.brainEnabled}
        onChange={(brainEnabled) => update({ brainEnabled })}
        label={`Let ${name} ask the second brain when a question is hard`}
        hint={`For deep questions, or questions about the code in your current project, ${name} quietly asks ${brainProvider === "gemini" ? "Gemini" : "Claude"} and tells you the answer. Only a short note appears when it reads your project.`}
      />
      <Toggle
        className="mt-4"
        checked={s.webSearch}
        onChange={(webSearch) => update({ webSearch })}
        label={`Let ${name} search the web`}
        hint={
          s.voiceEngine === "claude"
            ? `For current facts (the latest versions, news, docs), ${name} looks them up instead of guessing: a quick search through your Claude Code that can only search and read web pages. What pages say is never taken as an instruction.`
            : s.voiceEngine === "gemini-cli" || s.voiceEngine === "gemini-live"
              ? `For current facts (the latest versions, news, docs), ${name} looks them up instead of guessing. What pages say is never taken as an instruction.`
              : `For current facts (the latest versions, news, docs), ${name} looks them up instead of guessing, with xAI's own web and X search. What pages say is never taken as an instruction.`
        }
      />

      <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Helper engine</div>
      <Segmented
        value={helperEngine}
        onChange={(v) => update({ helperEngine: v })}
        options={[
          { value: "claude-code", label: "Claude Code" },
          { value: "gemini", label: "Gemini CLI" },
        ]}
      />
      <p className="mt-2 text-[12px] leading-snug text-muted">
        {helperEngine === "gemini"
          ? "Background helpers (Orbit anywhere) run through your Gemini CLI."
          : "Background helpers (Orbit anywhere) run through your Claude Code."}
      </p>

      <Reveal show={!!status && !status.found && (s.voiceEngine === "claude" || (brainProvider === "claude" && s.brainConnection === "claude-code") || helperEngine === "claude-code")}>
        <div className="mt-4">
          <p className="text-[12.5px] leading-snug text-amber-700">Claude Code isn't on {thisComputer} yet. To install it, paste this into a terminal:</p>
          <InstallCommand className="mt-2" />
          <SignInStep className="mt-2" />
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={checkAgain}
              disabled={checking === "checking"}
              className="h-8 shrink-0 rounded-lg px-3 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg disabled:opacity-50"
            >
              {checking === "checking" ? "Checking…" : "Check again"}
            </button>
            <SetupGuideLink className="h-8 shrink-0 rounded-lg px-3 text-[12.5px] leading-8 text-ink transition-colors hover:bg-soft hover:text-fg" />
            {checking === "still" && <span className="min-w-0 text-[12px] leading-snug text-muted">Still not found.</span>}
          </div>
        </div>
      </Reveal>

      <Reveal show={s.brainEnabled}>
        <>
          <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Second brain provider</div>
          <Segmented
            value={brainProvider}
            onChange={(v) => {
              update({ brainProvider: v });
              setTest({ state: "idle" });
            }}
            options={[
              { value: "claude", label: "Claude" },
              { value: "gemini", label: "Gemini" },
            ]}
          />
          <p className="mt-2 text-[12px] leading-snug text-muted">
            {brainProvider === "gemini"
              ? "Routes hard questions and project exploration through Gemini (using your Gemini API key if set, or Gemini CLI sign-in)."
              : "Routes hard questions and project exploration through Claude Code or your Anthropic API key."}
          </p>

          <Reveal show={brainProvider === "claude"}>
            <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Model</div>
            <Segmented
              value={s.brainModel}
              onChange={(brainModel) => update({ brainModel })}
              options={[
                { value: "auto", label: `${name} picks` },
                { value: "haiku", label: "Haiku" },
                { value: "sonnet", label: "Sonnet" },
                { value: "opus", label: "Opus" },
              ]}
            />
            <p className="mt-2 text-[12px] leading-snug text-muted">
              {s.brainModel === "auto"
                ? `${name} chooses per question: Haiku for quick lookups, Sonnet for most code questions, Opus only for hard problems.`
                : `Every question goes to ${s.brainModel[0].toUpperCase() + s.brainModel.slice(1)}.`}
            </p>
          </Reveal>

          <Toggle
            className="mt-4"
            checked={s.brainExplore}
            onChange={(brainExplore) => update({ brainExplore })}
            label="Read the current project"
            hint="May read the files of the project open in your session to answer: read-only, only inside that project folder, with common secret files (.env, keys, credentials) blocked. It can't run commands or change anything."
          />

          <Reveal show={brainProvider === "claude"}>
            <div className="mt-4 mb-1.5 text-[12.5px] text-ink">Connection</div>
            <Segmented
              value={s.brainConnection}
              onChange={(brainConnection) => {
                update({ brainConnection });
                setTest({ state: "idle" });
              }}
              options={[
                { value: "claude-code", label: "My Claude login" },
                { value: "api-key", label: "Anthropic API key" },
              ]}
            />
            <p className="mt-2 text-[12px] leading-snug text-muted">
              {s.brainConnection === "claude-code"
                ? "Uses your Claude Code sign-in, so questions count toward your Claude plan. No setup if you use Claude Code."
                : `Questions are billed to your Anthropic API account. The key is encrypted on ${thisComputer}.`}
            </p>

            <Reveal show={s.brainConnection === "claude-code" && !!status?.found && status.signedIn !== null}>
              {status && (
                <div className="mt-2 flex items-center justify-between gap-3 text-[12.5px]">
                  <span className={cn("min-w-0 leading-snug", status.signedIn ? "text-ink" : signingIn?.error ? "text-red-600" : "text-amber-700")}>
                    {status.signedIn
                      ? "Signed in to Claude Code ✓"
                      : signingIn?.error
                        ? signingIn.error
                        : signingIn
                          ? "Finish signing in in the window and browser that opened…"
                          : "Claude Code isn't signed in. Sign in here, or run claude once in a terminal."}
                  </span>
                  {!status.signedIn && (
                    <button
                      onClick={signIn}
                      disabled={!!signingIn && !signingIn.error}
                      className="h-8 shrink-0 rounded-lg bg-fg text-white transition-colors hover:bg-[#2b2b2b] px-3 text-[12.5px] font-medium disabled:opacity-40"
                    >
                      {signingIn && !signingIn.error ? "Waiting…" : "Sign in"}
                    </button>
                  )}
                </div>
              )}
            </Reveal>

            <Reveal show={s.brainConnection === "api-key"}>
              <div className="mt-2">
                {status?.hasKey && !key ? (
                  <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink">
                    <span>API key saved ✓</span>
                    <button onClick={() => saveKey("")} className="rounded-md px-2 py-1 text-muted hover:text-fg">
                      Remove
                    </button>
                  </div>
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
                      className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2 text-[13px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
                    />
                    <button disabled={!key.trim()} className="h-8 rounded-lg bg-fg text-white transition-colors hover:bg-[#2b2b2b] px-3 text-[12.5px] font-medium disabled:opacity-30">
                      Save
                    </button>
                  </form>
                )}
                {keyError && <p className="mt-1 text-[12px] text-red-600">{keyError}</p>}
              </div>
            </Reveal>
          </Reveal>

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={runTest}
              disabled={test.state === "testing"}
              className="h-8 shrink-0 rounded-lg px-3 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg disabled:opacity-50"
            >
              {test.state === "testing" ? "Testing…" : "Test connection"}
            </button>
            <span className={cn("min-w-0 text-[12px] leading-snug", test.state === "failed" ? "text-red-600" : test.state === "ok" ? "text-emerald-700" : "text-muted")}>
              {test.state === "idle"
                ? brainProvider === "gemini"
                  ? "Configure Gemini CLI or a Gemini API key in Voice engine above."
                  : status
                    ? status.found
                      ? `Using ${where}.`
                      : "Claude Code not found."
                    : ""
                : test.text}
            </span>
          </div>

          <Reveal show={brainProvider === "claude"}>
            <button onClick={() => setAdvanced((a) => !a)} className="mt-3 text-[12px] text-muted hover:text-fg">
              {advanced ? "Hide location" : "Claude Code location…"}
            </button>
            <Reveal show={advanced}>
              <div className="mt-2">
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onBlur={() => path.trim() !== s.brainClaudePath && update({ brainClaudePath: path.trim() })}
                  placeholder={status?.path && status.source !== "settings" ? `Automatic: ${status.path}` : "Automatic"}
                  spellCheck={false}
                  className="h-8 w-full rounded-lg border border-line bg-soft px-2 text-[12px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
                />
                <p className="mt-1 text-[11.5px] leading-snug text-faint">Leave empty to find it automatically. Otherwise, the full path to {isMac ? "claude" : "claude.exe"}.</p>
              </div>
            </Reveal>
          </Reveal>
        </>
      </Reveal>
    </Section>
  );
}

// ---------- T3 Code & smart routing ----------
const DRIFT_MIN = 0.5;
const DRIFT_MAX = 0.98;

function isValidLoopbackUrl(value: string) {
  if (!value) return true;
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function T3RoutingSection({ s, update, config }: { s: ExtendedSettings; update: Update; config: ExtendedAppConfig }) {
  const targetBackend: TargetBackend = s.targetBackend ?? "auto";
  const driftGuard = s.routingDriftGuard !== false;
  const queueBusy = s.routingQueueBusy !== false;
  const savedThreshold = typeof s.routingDriftThreshold === "number" ? s.routingDriftThreshold : 0.8;

  const [t3Status, setT3Status] = useState<T3Status | null>(null);
  const [endpoint, setEndpoint] = useState(s.t3Endpoint ?? "");
  const [endpointErr, setEndpointErr] = useState("");
  const [token, setToken] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [threshold, setThreshold] = useState(savedThreshold);
  const thresholdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setEndpoint(s.t3Endpoint ?? ""), [s.t3Endpoint]);
  useEffect(() => setThreshold(savedThreshold), [savedThreshold]);
  useEffect(() => () => clearTimeout(thresholdTimer.current), []);

  const refreshStatus = () =>
    fetch("/api/t3/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: T3Status | null) => d && setT3Status(d))
      .catch(() => {});

  useEffect(() => {
    refreshStatus();
  }, [targetBackend, s.t3Endpoint]);

  const saveEndpoint = async (raw: string) => {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!isValidLoopbackUrl(trimmed)) {
      setEndpointErr("Must be a local loopback URL (127.0.0.1, localhost, or ::1).");
      return;
    }
    setEndpointErr("");
    if (trimmed !== (s.t3Endpoint ?? "")) {
      await update({ t3Endpoint: trimmed });
      refreshStatus();
    }
  };

  const saveToken = async (value: string) => {
    setTokenMsg(null);
    try {
      const r = await postJson("/api/t3/token", { token: value });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setTokenMsg({ text: data.error || "Couldn't save the T3 Bearer token.", bad: true });
        return;
      }
      setToken("");
      setTokenOpen(false);
      setTokenMsg({ text: value ? "T3 Bearer token saved." : "T3 Bearer token removed." });
      refreshStatus();
    } catch {
      setTokenMsg({ text: "Couldn't reach Orbit.", bad: true });
    }
  };

  const changeThreshold = (v: number) => {
    setThreshold(v);
    clearTimeout(thresholdTimer.current);
    thresholdTimer.current = setTimeout(() => {
      void update({ routingDriftThreshold: v });
    }, 150);
  };

  const hasToken = t3Status ? t3Status.hasToken : !!config.hasT3Token;
  const active = t3Status ? t3Status.active : config.activeTarget === "t3-code";
  const pct = Math.round(threshold * 100);
  const fill = ((threshold - DRIFT_MIN) / (DRIFT_MAX - DRIFT_MIN)) * 100;

  return (
    <Section title="T3 Code & Smart Routing">
      <div className="mb-1.5 text-[12.5px] text-ink">Target backend</div>
      <Segmented
        value={targetBackend}
        onChange={async (v) => {
          await update({ targetBackend: v });
          refreshStatus();
        }}
        options={[
          { value: "auto", label: "Auto" },
          { value: "t3-code", label: "T3 Code" },
          { value: "claude-desktop", label: "Claude Desktop" },
        ]}
      />
      <p className="mt-2 text-[12px] leading-snug text-muted">
        {targetBackend === "t3-code"
          ? "Sends drafts and session switches to your local T3 Code bridge."
          : targetBackend === "claude-desktop"
            ? "Always targets the Claude Desktop window directly."
            : "Uses T3 Code automatically when a local endpoint is configured, otherwise falls back to Claude Desktop."}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-soft px-3 py-2 text-[12px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", active ? "bg-emerald-500" : "bg-black/25")} aria-hidden />
          <span className="truncate text-ink">
            {active
              ? `T3 Code active${t3Status?.endpoint ? ` (${t3Status.endpoint})` : ""}`
              : targetBackend === "t3-code" && !t3Status?.endpoint
                ? "T3 Code selected — set a local endpoint below"
                : "Claude Desktop active"}
          </span>
        </div>
        <button type="button" onClick={refreshStatus} className="shrink-0 text-[11.5px] text-muted hover:text-fg">
          Refresh
        </button>
      </div>

      <Reveal show={targetBackend !== "claude-desktop"}>
        <div className="mt-4">
          <label className="mb-1.5 block text-[12.5px] text-ink">T3 Code endpoint</label>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEndpoint(endpoint);
            }}
          >
            <input
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                if (endpointErr) setEndpointErr("");
              }}
              onBlur={() => void saveEndpoint(endpoint)}
              placeholder="http://127.0.0.1:3773"
              spellCheck={false}
              aria-label="T3 Code endpoint"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 text-[12.5px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
            />
            <button
              type="submit"
              disabled={endpoint.trim().replace(/\/+$/, "") === (s.t3Endpoint ?? "")}
              className="h-9 shrink-0 rounded-lg bg-fg px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30"
            >
              Save
            </button>
          </form>
          {endpointErr ? (
            <p className="mt-1 text-[12px] text-red-600">{endpointErr}</p>
          ) : (
            <p className="mt-1 text-[11.5px] leading-snug text-faint">Loopback URL only (127.0.0.1, localhost, or ::1). Leave empty to disable.</p>
          )}
        </div>

        <div className="mt-3 text-[12px] leading-snug">
          <div className="mb-1.5 text-[12.5px] text-ink">T3 Bearer token (optional)</div>
          {hasToken && !tokenOpen ? (
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-muted">Bearer token saved ✓</p>
              <button
                type="button"
                onClick={() => setTokenOpen(true)}
                className="shrink-0 rounded-lg bg-soft px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-black/[0.08] hover:text-fg"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => void saveToken("")}
                className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-muted transition-colors hover:text-fg"
              >
                Remove
              </button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (token.trim()) void saveToken(token.trim());
              }}
            >
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                aria-label="T3 Bearer token"
                placeholder="Optional Bearer token"
                className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 text-[13px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
              />
              <button disabled={!token.trim()} className="h-9 shrink-0 rounded-lg bg-fg px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30">
                Save
              </button>
            </form>
          )}
          {tokenMsg && <p className={cn("mt-1.5 text-[12px]", tokenMsg.bad ? "text-red-600" : "text-muted")}>{tokenMsg.text}</p>}
        </div>
      </Reveal>

      <Toggle
        className="mt-4"
        checked={driftGuard}
        onChange={(routingDriftGuard) => update({ routingDriftGuard })}
        label="Warn before drafting into an unrelated session/thread"
        hint="Gives a spoken heads-up before drafting if your prompt looks unrelated to the currently open session or thread."
      />
      <Reveal show={driftGuard}>
        <div className="mt-3 rounded-xl bg-soft px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between text-[12.5px]">
            <span className="text-ink">Drift warning threshold</span>
            <span className="tabular-nums text-fg">{pct}%</span>
          </div>
          <input
            type="range"
            min={DRIFT_MIN}
            max={DRIFT_MAX}
            step={0.01}
            value={threshold}
            aria-label="Drift warning threshold"
            onChange={(e) => changeThreshold(Number(e.target.value))}
            className="speed-slider w-full"
            style={{ background: `linear-gradient(to right, #0d0d0d ${fill}%, rgba(0,0,0,.1) ${fill}%)` }}
          />
          <div className="mt-1 flex justify-between text-[11px] text-faint">
            <span>50% (stricter)</span>
            <span>98% (only obvious drift)</span>
          </div>
        </div>
      </Reveal>

      <Toggle
        className="mt-4"
        checked={queueBusy}
        onChange={(routingQueueBusy) => update({ routingQueueBusy })}
        label="Queue confirmed prompts while busy"
        hint="Queues confirmed prompts if the active session or thread is mid-turn (still blocks if it is waiting on a permission or question)."
      />
    </Section>
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
          <div key={k} className="rounded-xl bg-soft px-3 py-2.5">
            <div className="text-[11.5px] text-muted">{k === "today" ? "Today" : "This month"}</div>
            <div className="text-[18px] font-semibold tracking-[-0.02em] tabular-nums">{usage ? money(usage[k].cost) : "…"}</div>
            <div className="text-[11.5px] text-muted tabular-nums">{usage ? `${usage[k].minutes} min connected` : ""}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-snug text-muted">
        An estimate from time connected to Grok. Your xAI console has the real bill. Orbit hangs up when you say "go to sleep", so sleeping costs nothing.
      </p>
      <label className="mt-3 flex items-center justify-between gap-3 text-[12.5px] text-ink">
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
          className="h-8 w-20 rounded-lg border border-line bg-soft px-2 text-right text-[13px] tabular-nums text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
        />
      </label>
    </Section>
  );
}

// ---------- about + key ----------
// ---------- updates ----------
function UpdatesSection({ version, auto, update }: { version: string; auto: boolean; update: Update }) {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => {
    desktop?.updates.get().then(setU);
    return desktop?.updates.onChange(setU);
  }, []);
  if (!u) return null;

  const status =
    u.status === "dev"
      ? "You're running Orbit from source, so it doesn't update itself."
      : u.status === "checking"
        ? "Checking for updates…"
        : u.status === "downloading"
          ? `Downloading Orbit ${u.version}… ${u.percent ?? 0}%`
          : u.status === "ready"
            ? `Orbit ${u.version} is ready. It installs when you quit Orbit, or now if you restart.`
            : u.status === "latest"
              ? "Up to date."
              : u.status === "error"
                ? u.message
                : null;

  return (
    <Section title="Updates">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-[12.5px] leading-snug text-muted">
          <div className="text-ink">Orbit {version}</div>
          {status && <div className="mt-0.5">{status}</div>}
        </div>
        {u.status === "ready" ? (
          <button onClick={() => desktop?.updates.install()} className="shrink-0 rounded-full bg-fg text-white transition-colors hover:bg-[#2b2b2b] px-3 py-1.5 text-[12.5px] font-medium">
            Restart to update
          </button>
        ) : (
          u.status !== "dev" && (
            <button
              disabled={u.status === "checking" || u.status === "downloading"}
              onClick={() => desktop?.updates.check()}
              className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg disabled:opacity-40"
            >
              Check now
            </button>
          )
        )}
      </div>
      {u.status !== "dev" && (
        <Toggle
          className="mt-4"
          checked={auto}
          onChange={(autoUpdate) => update({ autoUpdate })}
          label="Update automatically"
          hint="Orbit checks GitHub for a new release when it starts and every few hours, downloads it in the background, and installs it the next time you quit. Nothing about you is sent."
        />
      )}
    </Section>
  );
}

const keyStorageLabel = (kind: string) =>
  kind === "windows-dpapi"
    ? "encrypted with your Windows account"
    : kind === "macos-keychain"
      ? "encrypted with a key in your macOS Keychain"
      : kind === "env-file" ? "in the .env file (developer mode)" : "not available";

/** Grok voice's xAI key: add one (or replace it). Only Grok needs it; Claude voice never does. */
function XaiKey({ config, onSaved, focus }: { config: Pick<AppConfig, "hasKey" | "keyStorage">; onSaved: () => void; focus: boolean }) {
  const [open, setOpen] = useState(!config.hasKey);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!config.hasKey) setOpen(true);
  }, [config.hasKey]);
  return (
    <div className="mt-3 text-[12px] leading-snug">
      {config.hasKey ? (
        <div className="flex items-center gap-3">
          <p className="flex-1 text-muted">xAI key saved, {keyStorageLabel(config.keyStorage)}.</p>
          <button onClick={() => setOpen((o) => !o)} className="shrink-0 rounded-lg bg-soft px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-black/[0.08] hover:text-fg">
            Replace
          </button>
        </div>
      ) : (
        <p className="text-ink">
          Grok voice needs an xAI API key. Get one at{" "}
          <a href="https://console.x.ai" target="_blank" rel="noreferrer" className="text-fg underline decoration-black/25 underline-offset-2 hover:decoration-fg">
            console.x.ai
          </a>{" "}
          → API Keys. It's stored encrypted, only on {thisComputer}.
        </p>
      )}
      {open && (
        <form
          className="mt-2 flex gap-2"
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
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 text-[13px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
          />
          <button disabled={!key.trim()} className="rounded-lg bg-fg text-white transition-colors hover:bg-[#2b2b2b] px-3 text-[13px] font-medium disabled:opacity-30">
            Save
          </button>
        </form>
      )}
      {msg && <p className="mt-2 text-muted">{msg}</p>}
    </div>
  );
}

function AboutSection({ config }: { config: AppConfig }) {
  const storage = keyStorageLabel(config.keyStorage);

  return (
    <Section title="About">
      <div className="space-y-1 text-[12.5px] text-muted">
        <div>Orbit {config.version} · open source (MIT)</div>
        <div>xAI key (Grok voice only): {config.hasKey ? `saved, ${storage}` : "not set"}</div>
        <div className="pt-1 text-[11.5px] leading-snug text-faint">
          Not affiliated with xAI or Anthropic. Grok is a trademark of xAI; Claude is a trademark of Anthropic.
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="rounded-full px-3 py-1.5 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg">
          Source &amp; help
        </a>
        {desktop && (
          <button onClick={() => desktop?.openLogs()} className="rounded-full px-3 py-1.5 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg">
            Open log folder
          </button>
        )}
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-faint">
        Errors are logged (without keys or prompt text) so you can attach them to a bug report. Grok can read recent ones too. Just ask "what went wrong?"
      </p>
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
  if (e.metaKey) mods.push(isMac ? "Command" : "Super");
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
  if (!mods.some((x) => x !== "Shift") && !isFKey) return { partial: mods, error: isMac ? "Hold ⌃, ⌥ or ⌘ too, so it doesn't fire while you type." : "Hold Ctrl, Alt or Win too, so it doesn't fire while you type." };
  return { accel: [...mods, key].join("+"), partial: mods };
}

const MAC_KEYS: Record<string, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘", CommandOrControl: "⌘", Super: "⌘", Meta: "⌘" };
const labelParts = (accel: string) =>
  accel.split("+").map((p) => (isMac ? MAC_KEYS[p] || p : p === "Control" || p === "CommandOrControl" ? "Ctrl" : p === "Super" || p === "Meta" ? "Win" : p));

function Keys({ parts, dim }: { parts: string[]; dim?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {parts.map((p, i) => (
        <kbd key={i} className={cn("min-w-7 rounded-md border px-2 py-1 text-center font-sans text-[13px] font-medium", dim ? "border-black/10 bg-white text-faint" : "border-black/15 bg-white text-fg shadow-[0_1px_0_rgba(0,0,0,.08)]")}>
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
      <p className="-mt-1 text-[12.5px] leading-relaxed text-muted">Works from any app: starts Grok when it's off, and puts it to sleep or wakes it when it's on.</p>
      <button
        data-hotkey-recorder
        onClick={() => {
          setMessage(null);
          setRecording((r) => !r);
        }}
        className={cn("mt-4 flex min-h-12 w-full items-center justify-center rounded-xl border px-3 py-2 transition-colors", recording ? "border-black/40 bg-soft" : "border-line bg-soft hover:border-black/20")}
      >
        {recording ? (
          partial.length ? <Keys parts={labelParts(partial.join("+"))} dim /> : <span className="text-[13px] text-ink">Press your new shortcut…</span>
        ) : info ? (
          <Keys parts={labelParts(info.accelerator)} />
        ) : null}
      </button>
      <div className="mt-2 flex items-center justify-between text-[12px]">
        <span className="text-faint">{recording ? "Esc to cancel" : "Click to change"}</span>
        {!isDefault && !recording && info && (
          <button onClick={() => save(info.defaultAccelerator)} className="text-muted underline-offset-2 hover:text-fg hover:underline">
            Reset to {labelParts(info.defaultAccelerator).join("+")}
          </button>
        )}
      </div>
      {message && <p className={cn("mt-3 text-[12.5px] leading-snug", message.bad ? "text-amber-700" : "text-emerald-700")}>{message.text}</p>}
      {info && !info.registered && !message && (
        <p className="mt-3 text-[12.5px] leading-snug text-amber-700">This shortcut isn't active. Another app is probably using it. Pick a different one.</p>
      )}
    </Section>
  );
}
