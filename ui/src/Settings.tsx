// Settings screen. Everything saves as soon as you change it.
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { desktop, isMac, thisComputer, type HotkeyInfo, type UpdateState } from "./desktop";
import { postJson, type AppConfig, type Settings as SettingsT } from "./useAppState";
import VoiceSettings, { prefetchVoices } from "./VoiceSettings";
import PillScroll from "./components/PillScroll";
import Reveal from "./components/Reveal";
import { PULSE_MAX, PULSE_MIN } from "./orbLook";
import { ARROW_PATH, PREVIEW, css } from "./mouse/shape.js";
import { MacPermissionsSection } from "./MacPermissions";

export const REPO_URL = "https://github.com/Cookiebubba/orbit-voice";

type Update = (patch: Partial<SettingsT>) => Promise<void>;

const GAP = 12; // between sections (part of each section's open/close, so nothing jumps)

export default function Settings({ config, update, onClose }: { config: AppConfig; update: Update; onClose: () => void }) {
  const s = config.settings;
  // The assistant's name in the text: Grok, or Orbit when Claude is the voice ("Claude" is the coder).
  const claude = s.voiceEngine === "claude";
  const name = claude ? "Orbit" : "Grok";
  // Both voice lists up front, so switching engines opens the other card at its real size.
  useEffect(() => {
    prefetchVoices("grok");
    prefetchVoices("claude");
  }, []);
  return (
    <PillScroll className="flex flex-col px-5 pb-8">
      <button onClick={onClose} className="mb-3 flex items-center gap-1.5 self-start rounded-md py-1 pr-2 text-[13px] text-muted transition-colors hover:text-fg">
        <ArrowLeft size={15} /> Back
      </button>
      <h2 className="wordmark mb-1 text-[38px]">Settings</h2>
      <p className="mt-2 mb-3 text-[12.5px] text-muted">Everything saves as soon as you change it.</p>

      <div className="flex flex-col">
        <VoiceEngineSection s={s} update={update} />
        {/* Each engine's own voice card: one closes as the other opens. */}
        <Reveal show={!claude} gap={GAP}>
          <VoiceSettings engine="grok" volume={s.voiceVolume} onVolume={(voiceVolume) => update({ voiceVolume })} />
        </Reveal>
        <Reveal show={claude} gap={GAP}>
          <VoiceSettings engine="claude" volume={s.voiceVolume} onVolume={(voiceVolume) => update({ voiceVolume })} />
        </Reveal>

        <Reveal show gap={GAP}>
          <Section title="Listening">
            <Segmented
              value={s.listenMode}
              onChange={(listenMode) => update({ listenMode })}
              options={[
                { value: "always", label: "Always on" },
                { value: "tap", label: "One question at a time" },
              ]}
            />
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
              {s.listenMode === "always"
                ? `${name} hears you until you say "go to sleep" or press ${s.hotkeyLabel}. Then it hangs up${claude ? "" : ", so nothing is billed,"} until you press ${s.hotkeyLabel}${s.wakeWord ? ' or say “Hey Orbit”' : ""} again.`
                : `Press ${s.hotkeyLabel}${s.wakeWord ? ' or say “Hey Orbit”' : ""}, ask one question, and ${name} hangs up after answering (it waits up to a minute if a prompt needs your yes). Nothing in the background gets picked up.`}
            </p>
            <Toggle
              className="mt-4"
              checked={s.halfDuplex}
              onChange={(halfDuplex) => update({ halfDuplex })}
              label={`Don't listen while ${name} is talking`}
              hint={`Turn on if you use speakers instead of headphones, so ${name} doesn't hear itself. You can't interrupt it then.`}
            />
            <Toggle
              className="mt-4"
              checked={s.wakeWord}
              onChange={(wakeWord) => update({ wakeWord })}
              label="Wake word: say “Hey Orbit” (or “Hey Grok”)"
              hint={`Starts ${name} hands-free after it has gone to sleep. Recognized entirely on ${thisComputer} by a small offline speech model: no audio leaves your computer and it costs nothing. Each wake starts a fresh conversation.`}
            />
          </Section>
        </Reveal>

        <Reveal show gap={GAP}>
          <Section title="When Claude finishes">
            <Segmented
              value={s.announce}
              onChange={(announce) => update({ announce })}
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
                onChange={(announceWake) => update({ announceWake })}
                label={`Wake ${name} to say it`}
                hint={`While ${name} is asleep, it connects just long enough to tell you, then listens for 3 seconds in case you want something. The mic opens only after it has spoken; press the hotkey to stop it.${claude ? " Each wake uses a little of your Claude plan." : " Each wake bills a few seconds of xAI time."}`}
              />
              <Toggle
                className="mt-4"
                checked={s.wakeOnResults}
                onChange={(wakeOnResults) => update({ wakeOnResults })}
                label={`Wake ${name} when something you asked for is ready`}
                hint={`When Claude finishes a prompt ${name} sent for you, or the second brain answers after you hung up (a question still running then keeps going), ${name} wakes to tell you. At most 6 wakes an hour.`}
              />
            </Reveal>
          </Section>
        </Reveal>

        <Reveal show gap={GAP}>
          <SecondBrainSection s={s} update={update} name={name} />
        </Reveal>

        {desktop && isMac && (
          <Reveal show gap={GAP}>
            <MacPermissionsSection />
          </Reveal>
        )}

        {desktop && (
          <Reveal show gap={GAP}>
            <AnywhereSection s={s} update={update} name={name} />
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
                onChange={(orbStick) => update({ orbStick })}
                label="Stick to Claude Code"
                hint="The orb rides on the Claude window: it follows it around, stays on top of it, and hides while Claude is minimized. Drag the orb to choose its spot on the window." 
              />
              <Toggle
                className="mt-4"
                checked={s.orbPulse}
                onChange={(orbPulse) => update({ orbPulse })}
                label="Pulse with your voice"
                hint="The orb grows very slightly as you speak, so you can see it hearing you."
              />
              <Toggle
                className="mt-4"
                checked={s.orbPulseGrok}
                onChange={(orbPulseGrok) => update({ orbPulseGrok })}
                label={`Pulse with ${name}'s voice`}
                hint={`The same while ${name} is talking.`}
              />
              <Reveal show={s.orbPulse || s.orbPulseGrok}>
                <PulseAmount value={s.orbPulseAmount} update={update} />
              </Reveal>
            </Section>
          </Reveal>
        )}

        {desktop && (
          <Reveal show gap={GAP}>
            <AvatarSection s={s} update={update} name={name} />
          </Reveal>
        )}

        {/* What Grok costs: xAI bills by the minute. Claude voice has no xAI cost. */}
        <Reveal show={!claude} gap={GAP}>
          <UsageSection costPerMinute={s.costPerMinute} update={update} />
        </Reveal>

        {desktop && (
          <Reveal show gap={GAP}>
            <UpdatesSection version={config.version} auto={s.autoUpdate} update={update} />
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
function AnywhereSection({ s, update, name }: { s: SettingsT; update: Update; name: string }) {
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
function AvatarSection({ s, update, name }: { s: SettingsT; update: Update; name: string }) {
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
          hint={`Off: ${avatar === "qubit" ? "Qubit" : "the pixel buddy"} stands in for the orb when ${name} is minimized. Open ${name} again from its ${isMac ? "menu bar" : "tray"} icon.`}
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

// ---------- second brain ----------
type ClaudeVoiceStatus = { models: { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string }; mb: number; claudeFound: boolean; stt?: Record<SttId, SttState> };

/** Grok, or (beta) Claude through your own Claude Code with speech models on this PC. */
function VoiceEngineSection({ s, update }: { s: SettingsT; update: Update }) {
  const [status, setStatus] = useState<ClaudeVoiceStatus | null>(null);
  const refresh = () =>
    fetch("/api/claude-voice")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    refresh();
  }, [s.voiceEngine]);
  // While the models download, check progress every second.
  const sttDownloading = !!status?.stt && Object.values(status.stt).some((x) => x.state === "downloading");
  useEffect(() => {
    if (status?.models.state !== "downloading" && !sttDownloading) return;
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [status?.models.state, sttDownloading]);
  const downloadStt = async (id: SttId) => {
    const r = await (await postJson("/api/claude-voice/stt-download", { id })).json().catch(() => null);
    if (r?.stt) setStatus((st) => (st ? { ...st, stt: r.stt } : st));
    else refresh();
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
    if (r?.models) setStatus((st) => (st ? { ...st, models: r.models } : st));
    else refresh();
  };
  const choose = (voiceEngine: "grok" | "claude") => {
    update({ voiceEngine });
    if (voiceEngine === "claude" && status && status.models.state !== "ready" && status.models.state !== "downloading") download();
  };

  const m = status?.models;
  return (
    <Section title="Voice engine">
      <Segmented
        value={s.voiceEngine}
        onChange={choose}
        options={[
          { value: "grok", label: "Grok" },
          { value: "claude", label: "Claude (beta)" },
        ]}
      />
      <Reveal show={s.voiceEngine === "grok"}>
        <p className="mt-2 text-[12px] leading-snug text-muted">Grok's realtime voice, billed by xAI per minute.</p>
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
        <p className="mt-2 text-[12px] leading-snug text-muted">{STT.find((o) => o.value === s.claudeVoiceStt)?.hint} All on {thisComputer}. (Grok hears you on xAI's side: this is for Claude voice only.)</p>
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
        {status && (
          <div className="mt-3 text-[12px] leading-snug">
            <Reveal show={!status.claudeFound}>
              <p className="mb-2 text-amber-700">Claude Code wasn't found. Set it up under Second brain below.</p>
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
    </Section>
  );
}

type BrainStatus = { found: boolean; path: string | null; source: "settings" | "path" | "claude-desktop" | null; hasKey: boolean; signedIn: boolean | null };

function SecondBrainSection({ s, update, name }: { s: SettingsT; update: Update; name: string }) {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "failed"; text?: string }>({ state: "idle" });
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState("");
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

  const where = status?.source === "claude-desktop" ? "the copy inside the Claude app" : status?.source === "settings" ? "the path below" : `Claude Code on ${thisComputer}`;
  return (
    <Section title="Second brain">
      <Toggle
        checked={s.brainEnabled}
        onChange={(brainEnabled) => update({ brainEnabled })}
        label={`Let ${name} ask Claude when a question is hard`}
        hint={`For deep questions, or questions about the code in your current project, ${name} quietly asks Claude and tells you the answer. Only a short note appears when Claude reads your project.`}
      />
      <Toggle
        className="mt-4"
        checked={s.webSearch}
        onChange={(webSearch) => update({ webSearch })}
        label={`Let ${name} search the web`}
        hint={
          s.voiceEngine === "claude"
            ? `For current facts (the latest versions, news, docs), ${name} looks them up instead of guessing: a quick search through your Claude Code that can only search and read web pages. What pages say is never taken as an instruction.`
            : `For current facts (the latest versions, news, docs), ${name} looks them up instead of guessing, with xAI's own web and X search. What pages say is never taken as an instruction.`
        }
      />
      <Reveal show={s.brainEnabled}>
        <>
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
          <Toggle
            className="mt-4"
            checked={s.brainExplore}
            onChange={(brainExplore) => update({ brainExplore })}
            label="Read the current project"
            hint="Claude may read the files of the project open in your Claude session to answer: read-only, only inside that project folder, with common secret files (.env, keys, credentials) blocked. It can't run commands or change anything."
          />

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
            {status && <div className="mt-2 flex items-center justify-between gap-3 text-[12.5px]">
              <span className={cn("min-w-0 leading-snug", status.signedIn ? "text-ink" : signingIn?.error ? "text-red-600" : "text-amber-700")}>
                {status.signedIn
                  ? "Signed in to Claude Code ✓"
                  : signingIn?.error
                    ? signingIn.error
                    : signingIn
                      ? "Finish signing in in the window and browser that opened…"
                      : "Claude Code isn't signed in (or its sign-in expired)."}
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
            </div>}
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

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={runTest}
              disabled={test.state === "testing"}
              className="h-8 shrink-0 rounded-lg px-3 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg disabled:opacity-50"
            >
              {test.state === "testing" ? "Testing…" : "Test connection"}
            </button>
            <span className={cn("min-w-0 text-[12px] leading-snug", test.state === "failed" ? "text-red-600" : test.state === "ok" ? "text-emerald-700" : "text-muted")}>
              {test.state === "idle" ? (status ? (status.found ? `Using ${where}.` : "Claude Code not found.") : "") : test.text}
            </span>
          </div>

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
        </>
      </Reveal>
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

function AboutSection({ config }: { config: AppConfig }) {
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const storage =
    config.keyStorage === "windows-dpapi"
      ? "encrypted with your Windows account"
      : config.keyStorage === "macos-keychain"
        ? "encrypted with a key in your macOS Keychain"
        : config.keyStorage === "env-file" ? "in the .env file (developer mode)" : "not available";

  return (
    <Section title="About">
      <div className="space-y-1 text-[12.5px] text-muted">
        <div>Orbit {config.version} · open source (MIT)</div>
        <div>xAI key: {config.hasKey ? `saved, ${storage}` : "not set"}</div>
        <div className="pt-1 text-[11.5px] leading-snug text-faint">
          Not affiliated with xAI or Anthropic. Grok is a trademark of xAI; Claude is a trademark of Anthropic.
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="rounded-full px-3 py-1.5 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg">
          Source &amp; help
        </a>
        <button onClick={() => setReplacing((r) => !r)} className="rounded-full px-3 py-1.5 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg">
          Replace xAI key
        </button>
        {desktop && (
          <button onClick={() => desktop?.openLogs()} className="rounded-full px-3 py-1.5 text-[12.5px] bg-soft text-ink transition-colors hover:bg-black/[0.08] hover:text-fg">
            Open log folder
          </button>
        )}
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-faint">
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
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-soft px-2.5 text-[13px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40 focus:bg-white"
          />
          <button disabled={!key.trim()} className="rounded-lg bg-fg text-white transition-colors hover:bg-[#2b2b2b] px-3 text-[13px] font-medium disabled:opacity-30">
            Save
          </button>
        </form>
      )}
      {msg && <p className="mt-2 text-[12px] text-muted">{msg}</p>}
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
