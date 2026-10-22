// Settings screen. Everything saves as soon as you change it.
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { desktop, type HotkeyInfo, type UpdateState } from "./desktop";
import { postJson, type AppConfig, type Settings as SettingsT } from "./useAppState";
import VoiceSettings from "./VoiceSettings";
import PillScroll from "./components/PillScroll";
import { PULSE_MAX, PULSE_MIN } from "./orbLook";

export const REPO_URL = "https://github.com/Cookiebubba/orbit-voice";

type Update = (patch: Partial<SettingsT>) => Promise<void>;

export default function Settings({ config, update, onClose }: { config: AppConfig; update: Update; onClose: () => void }) {
  const s = config.settings;
  return (
    <PillScroll className="flex flex-col px-4 pb-6">
      <button onClick={onClose} className="mb-4 flex items-center gap-1.5 self-start rounded-md py-1 pr-2 text-[13px] text-white/60 hover:text-white">
        <ArrowLeft size={15} /> Back
      </button>
      <h2 className="mb-5 text-[17px] font-semibold tracking-tight">Settings</h2>

      <div className="space-y-3">
        <VoiceEngineSection s={s} update={update} />
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
          {s.announce === "speak" && (
            <Toggle
              className="mt-4"
              checked={s.announceWake}
              onChange={(announceWake) => update({ announceWake })}
              label="Wake Grok to say it"
              hint="While Grok is asleep, it connects just long enough to tell you, then listens for 3 seconds in case you want something. The mic opens only after it has spoken; press the hotkey to stop it. Each wake bills a few seconds of xAI time."
            />
          )}
          {s.announce === "speak" && (
            <Toggle
              className="mt-4"
              checked={s.wakeOnResults}
              onChange={(wakeOnResults) => update({ wakeOnResults })}
              label="Wake Grok when something you asked for is ready"
              hint="When Claude finishes a prompt Grok sent for you, or the second brain answers after you hung up (a question still running then keeps going), Grok wakes to tell you. At most 6 wakes an hour."
            />
          )}
        </Section>

        <SecondBrainSection s={s} update={update} />

        {desktop && <HotkeySection />}

        {desktop && (
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
              label="Pulse with Grok's voice"
              hint="The same while Grok is talking."
            />
            {(s.orbPulse || s.orbPulseGrok) && <PulseAmount value={s.orbPulseAmount} update={update} />}
          </Section>
        )}

        <UsageSection costPerMinute={s.costPerMinute} update={update} />

        {desktop && <UpdatesSection version={config.version} auto={s.autoUpdate} update={update} />}

        <AboutSection config={config} />
      </div>
    </PillScroll>
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

// ---------- pulse amount ----------
/** How much the orb grows at full volume (1–10%). Saves when you let go of the slider. */
function PulseAmount({ value, update }: { value: number; update: Update }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const pct = Math.round(v * 100);
  const fill = ((v - PULSE_MIN) / (PULSE_MAX - PULSE_MIN)) * 100;
  return (
    <div className="mt-3 rounded-xl border border-white/10 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between text-[12.5px]">
        <span className="text-white/70">How much it pulses</span>
        <span className="tabular-nums text-white/90">{pct}%</span>
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
        style={{ background: `linear-gradient(to right, #fff ${fill}%, rgba(255,255,255,.15) ${fill}%)` }}
      />
      <div className="mt-1 flex justify-between text-[11px] text-white/40">
        <span>Subtle</span>
        <span>Noticeable</span>
      </div>
    </div>
  );
}

// ---------- mute my mic in other apps ----------
type MicApp = { exe: string; name: string; active: boolean; running: boolean; action: "mute" | "leave"; why: "you" | "recording-or-routing" | "default" };

// ---------- second brain ----------
type ClaudeVoiceStatus = { models: { state: "idle" | "downloading" | "ready" | "error"; percent: number; error: string }; mb: number; claudeFound: boolean };

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
  useEffect(() => {
    if (status?.models.state !== "downloading") return;
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [status?.models.state]);
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
      <p className="mt-2 text-[12px] leading-snug text-white/45">
        {s.voiceEngine === "grok"
          ? "Grok's realtime voice, billed by xAI per minute."
          : "Claude Haiku through your own Claude Code sign-in, with speech recognized and spoken on this PC. No xAI cost. Replies take a moment longer than Grok's. Takes effect on the next call."}
      </p>
      {s.voiceEngine === "claude" && status && (
        <div className="mt-3 text-[12px] leading-snug">
          {!status.claudeFound && <p className="text-amber-300/90">Claude Code wasn't found. Set it up under Second brain below.</p>}
          {m?.state === "ready" && <p className="text-white/55">Speech models ready.</p>}
          {m?.state === "downloading" && <p className="text-white/70">Downloading speech models… {m.percent}%</p>}
          {(m?.state === "idle" || m?.state === "error") && (
            <div className="flex items-center gap-3">
              <p className={cn("flex-1", m.state === "error" ? "text-amber-300/90" : "text-white/55")}>
                {m.state === "error" ? `Download failed: ${m.error}` : `Needs about ${status.mb} MB of speech models, kept on this PC.`}
              </p>
              <button onClick={download} className="shrink-0 rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/85 hover:bg-white/10">
                {m.state === "error" ? "Retry" : "Download"}
              </button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

type BrainStatus = { found: boolean; path: string | null; source: "settings" | "path" | "claude-desktop" | null; hasKey: boolean; signedIn: boolean | null };

function SecondBrainSection({ s, update }: { s: SettingsT; update: Update }) {
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

  const where = status?.source === "claude-desktop" ? "the copy inside the Claude app" : status?.source === "settings" ? "the path below" : "Claude Code on this PC";
  return (
    <Section title="Second brain">
      <Toggle
        checked={s.brainEnabled}
        onChange={(brainEnabled) => update({ brainEnabled })}
        label="Let Grok ask Claude when a question is hard"
        hint="For deep questions, or questions about the code in your current project, Grok quietly asks Claude and tells you the answer. Only a short note appears when Claude reads your project."
      />
      {s.brainEnabled && (
        <>
          <div className="mt-4 mb-1.5 text-[12.5px] text-white/70">Model</div>
          <Segmented
            value={s.brainModel}
            onChange={(brainModel) => update({ brainModel })}
            options={[
              { value: "auto", label: "Grok picks" },
              { value: "haiku", label: "Haiku" },
              { value: "sonnet", label: "Sonnet" },
              { value: "opus", label: "Opus" },
            ]}
          />
          <p className="mt-2 text-[12px] leading-snug text-white/45">
            {s.brainModel === "auto"
              ? "Grok chooses per question: Haiku for quick lookups, Sonnet for most code questions, Opus only for hard problems."
              : `Every question goes to ${s.brainModel[0].toUpperCase() + s.brainModel.slice(1)}.`}
          </p>
          <Toggle
            className="mt-4"
            checked={s.brainExplore}
            onChange={(brainExplore) => update({ brainExplore })}
            label="Read the current project"
            hint="Claude may read the files of the project open in your Claude session to answer: read-only, only inside that project folder, with common secret files (.env, keys, credentials) blocked. It can't run commands or change anything."
          />

          <div className="mt-4 mb-1.5 text-[12.5px] text-white/70">Connection</div>
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
          <p className="mt-2 text-[12px] leading-snug text-white/45">
            {s.brainConnection === "claude-code"
              ? "Uses your Claude Code sign-in, so questions count toward your Claude plan. No setup if you use Claude Code."
              : "Questions are billed to your Anthropic API account. The key is encrypted on this PC."}
          </p>

          {s.brainConnection === "claude-code" && status?.found && status.signedIn !== null && (
            <div className="mt-2 flex items-center justify-between gap-3 text-[12.5px]">
              <span className={cn("min-w-0 leading-snug", status.signedIn ? "text-white/70" : signingIn?.error ? "text-red-300" : "text-amber-200/90")}>
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
                  className="h-8 shrink-0 rounded-lg bg-white px-3 text-[12.5px] font-medium text-black disabled:opacity-40"
                >
                  {signingIn && !signingIn.error ? "Waiting…" : "Sign in"}
                </button>
              )}
            </div>
          )}

          {s.brainConnection === "api-key" && (
            <div className="mt-2">
              {status?.hasKey && !key ? (
                <div className="flex items-center justify-between gap-2 text-[12.5px] text-white/70">
                  <span>API key saved ✓</span>
                  <button onClick={() => saveKey("")} className="rounded-md px-2 py-1 text-white/50 hover:text-white">
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
                    className="h-8 min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 text-[13px] outline-none select-text focus:border-white/40"
                  />
                  <button disabled={!key.trim()} className="h-8 rounded-lg bg-white px-3 text-[12.5px] font-medium text-black disabled:opacity-30">
                    Save
                  </button>
                </form>
              )}
              {keyError && <p className="mt-1 text-[12px] text-red-300">{keyError}</p>}
            </div>
          )}

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={runTest}
              disabled={test.state === "testing"}
              className="h-8 shrink-0 rounded-lg border border-white/15 px-3 text-[12.5px] text-white/80 hover:border-white/40 disabled:opacity-50"
            >
              {test.state === "testing" ? "Testing…" : "Test connection"}
            </button>
            <span className={cn("min-w-0 text-[12px] leading-snug", test.state === "failed" ? "text-red-300" : test.state === "ok" ? "text-emerald-300" : "text-white/45")}>
              {test.state === "idle" ? (status ? (status.found ? `Using ${where}.` : "Claude Code not found.") : "") : test.text}
            </span>
          </div>

          <button onClick={() => setAdvanced((a) => !a)} className="mt-3 text-[12px] text-white/45 hover:text-white/80">
            {advanced ? "Hide location" : "Claude Code location…"}
          </button>
          {advanced && (
            <div className="mt-2">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onBlur={() => path.trim() !== s.brainClaudePath && update({ brainClaudePath: path.trim() })}
                placeholder={status?.path && status.source !== "settings" ? `Automatic: ${status.path}` : "Automatic"}
                spellCheck={false}
                className="h-8 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-[12px] outline-none select-text focus:border-white/40"
              />
              <p className="mt-1 text-[11.5px] leading-snug text-white/40">Leave empty to find it automatically. Otherwise, the full path to claude.exe.</p>
            </div>
          )}
        </>
      )}
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
        <div className="min-w-0 text-[12.5px] leading-snug text-white/60">
          <div className="text-white/80">Orbit {version}</div>
          {status && <div className="mt-0.5">{status}</div>}
        </div>
        {u.status === "ready" ? (
          <button onClick={() => desktop?.updates.install()} className="shrink-0 rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium text-black">
            Restart to update
          </button>
        ) : (
          u.status !== "dev" && (
            <button
              disabled={u.status === "checking" || u.status === "downloading"}
              onClick={() => desktop?.updates.check()}
              className="shrink-0 rounded-full border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80 hover:border-white/35 disabled:opacity-40"
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
