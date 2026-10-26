// The first-run onboarding (Orbit Native's VoiceSetupView, on Windows): "How should Orbit talk?",
// Claude voice or Grok voice as two cards, and the chosen one's setup right here through the same
// bridge calls Settings uses: Claude Code (the install command, its sign-in, the speech models) or
// the xAI key. "Continue" once it's ready; "Skip this step" and "Skip setup" end it too (Windows
// has no permission steps to follow). The rules are in onboarding-model.js.
import { useEffect, useRef, useState } from "react";
import { Check, Circle, CircleCheck, Laptop, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { desktop, isMac, thisComputer } from "./desktop";
import { postJson, type AppConfig, type Settings as SettingsT } from "./useAppState";
import { InstallCommand, SetupGuideLink, SignInStep } from "./components/ClaudeSetup";
import { claudeInstall } from "./talk.js";
import { ONBOARDING_DONE, claudeCodeDetail, engineOf, modelsDetail, refreshVoiceSetup, signInAndWait, signInDetail, voiceReady, type VoiceSetupStatus } from "./onboarding-model.js";

const fetchStatus = (): Promise<VoiceSetupStatus | null> =>
  fetch("/api/claude-voice")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
const startDownload = () =>
  postJson("/api/claude-voice/download", {})
    .then((r) => r.json())
    .catch(() => null);

export default function Onboarding({ config, update, onKeySaved }: { config: AppConfig; update: (patch: Partial<SettingsT>) => Promise<void>; onKeySaved: () => void }) {
  const engine = engineOf(config.settings);
  const [status, setStatus] = useState<VoiceSetupStatus | null>(null);
  const [signingIn, setSigningIn] = useState<{ error: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const refresh = async () => {
    const st = await refreshVoiceSetup({ engine, fetchStatus, startDownload });
    if (st && alive.current) setStatus(st);
  };
  useEffect(() => {
    void refresh();
  }, [engine]);
  // While the speech models download, follow their progress every second.
  const downloading = engine === "claude" && status?.models.state === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const id = setInterval(() => void refresh(), 1000);
    return () => clearInterval(id);
  }, [downloading]);

  const ready = voiceReady(engine, { hasKey: config.hasKey, status });
  const done = () => void update(ONBOARDING_DONE);
  const choose = (e: "claude" | "grok") => e !== engine && void update({ voiceEngine: e });

  const signIn = async () => {
    setSigningIn({ error: null });
    const r = await signInAndWait({
      login: () => postJson("/api/brain/login", {}).then((x) => x.json()),
      fetchStatus,
      onStatus: (st) => alive.current && setStatus(st),
      cancelled: () => !alive.current,
    });
    if (!alive.current) return;
    setSigningIn(r.error ? { error: r.error } : null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3">
        <div className="eyebrow pt-3">Voice</div>
        <h1 className="mt-2 text-[24px] leading-[1.15] font-bold tracking-[-0.03em] text-fg">How should Orbit talk?</h1>
        <p className="mt-1.5 text-[13px] leading-snug text-ink">Pick one and set it up. You can switch any time in Settings.</p>
        <div className="mt-3.5 grid grid-cols-2 gap-2.5">
          <EngineCard
            icon={<Laptop size={12} strokeWidth={2.5} />}
            name="Claude"
            blurb={`Uses your Claude Code sign-in. Speech stays on ${thisComputer}.`}
            tag="No extra cost"
            accent="claude"
            selected={engine === "claude"}
            onClick={() => choose("claude")}
          />
          <EngineCard
            icon={<Zap size={12} strokeWidth={2.5} />}
            name="Grok"
            blurb="xAI's realtime voice, with the quickest replies."
            tag="Paid per minute"
            accent="fg"
            selected={engine === "grok"}
            onClick={() => choose("grok")}
          />
        </div>
        <div className="mt-2.5 rounded-[14px] bg-soft p-3">
          {engine === "grok" ? <GrokSetup config={config} onSaved={onKeySaved} /> : <ClaudeSetup status={status} signingIn={signingIn} onSignIn={signIn} onCheck={refresh} onRetry={() => startDownload().then(refresh)} />}
        </div>
      </div>
      <div className="shrink-0 border-t border-line px-6 pt-2.5">
        <button onClick={done} disabled={!ready} className="h-11 w-full rounded-full bg-fg text-[14px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30 disabled:hover:bg-fg">
          Continue
        </button>
        <div className="flex items-center pt-2 pb-4">
          <button onClick={done} title="Set the voice up later in Settings → Voice engine." className="py-1.5 text-[12.5px] text-ink transition-colors hover:text-fg">
            Skip this step
          </button>
          <button onClick={done} title="Skip the whole setup. Settings has all of it any time." className="ml-auto py-1.5 text-[12.5px] text-faint transition-colors hover:text-fg">
            Skip setup
          </button>
        </div>
      </div>
    </div>
  );
}

/** One of the two voices, as a card to pick. */
function EngineCard(props: { icon: React.ReactNode; name: string; blurb: string; tag: string; accent: "claude" | "fg"; selected: boolean; onClick: () => void }) {
  const { selected } = props;
  return (
    <button
      onClick={props.onClick}
      aria-label={`${props.name} voice`}
      aria-pressed={selected}
      title={props.blurb}
      className={cn(
        "flex min-h-[118px] flex-col items-start rounded-[14px] px-[11px] py-3 text-left transition-colors",
        selected ? "bg-white shadow-[inset_0_0_0_1.5px_#0d0d0d]" : "bg-soft shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] hover:bg-black/[0.06]",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full",
            selected ? (props.accent === "claude" ? "bg-claude/[0.12] text-claude" : "bg-fg/[0.12] text-fg") : "bg-black/5 text-muted",
          )}
        >
          {props.icon}
        </span>
        <span className="text-[15px] font-semibold whitespace-nowrap text-fg">{props.name}</span>
        <span aria-hidden className={cn("ml-auto", selected ? "text-fg" : "text-[#c4c7cb]")}>
          {selected ? <CircleCheck size={16} fill="currentColor" stroke="white" /> : <Circle size={16} />}
        </span>
      </span>
      <span className="mt-2 text-[11.5px] leading-snug text-muted">{props.blurb}</span>
      <span className={cn("mt-auto pt-1.5 font-mono text-[9.5px] font-medium tracking-[0.06em] uppercase", selected ? "text-ink" : "text-faint")}>{props.tag}</span>
    </button>
  );
}

/** A setup item: a tick when done, its name, how it stands, and an optional button. */
function SetupRow(props: { done: boolean; title: string; detail?: string | null; detailClass?: string; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("flex items-center gap-2.5", props.className)}>
      <span aria-hidden className={cn("grid size-[18px] shrink-0 place-items-center rounded-full", props.done ? "bg-emerald-500 text-white" : "bg-white shadow-[inset_0_0_0_1.5px_#c4c7cb]")}>
        {props.done && <Check size={10} strokeWidth={3.5} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-fg">{props.title}</span>
        {props.detail && <span className={cn("block text-[11.5px] leading-snug", props.detailClass ?? (props.done ? "text-emerald-700" : "text-muted"))}>{props.detail}</span>}
      </span>
      {props.children}
    </div>
  );
}

const SMALL_DARK = "h-7 shrink-0 rounded-lg bg-fg px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30";
const SMALL_SOFT = "rounded-full bg-white px-3 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-black/[0.08] hover:text-fg";

function ClaudeSetup({ status, signingIn, onSignIn, onCheck, onRetry }: { status: VoiceSetupStatus | null; signingIn: { error: string | null } | null; onSignIn: () => void; onCheck: () => void; onRetry: () => void }) {
  const found = status?.claudeFound;
  const signed = status?.signedIn === true;
  const waiting = !!signingIn && !signingIn.error;
  const m = status?.models;
  const where = claudeInstall(desktop?.platform ?? (isMac ? "darwin" : "win32")).where;
  return (
    <>
      {/* 1. Claude Code on this computer */}
      <SetupRow done={found === true} title="Claude Code" detail={claudeCodeDetail(status)} />
      {found === false && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[12px] leading-snug text-ink">Copy the install command into {where}, run it, then press Check again.</p>
          <InstallCommand />
          <SignInStep />
          <div className="flex gap-2">
            <button onClick={onCheck} className={SMALL_SOFT}>
              Check again
            </button>
            <SetupGuideLink className={SMALL_SOFT} />
          </div>
        </div>
      )}
      {/* 2. Signed in to it */}
      <SetupRow className="mt-2.5" done={signed} title="Sign in" detail={signInDetail(status, signingIn)} detailClass={signingIn?.error ? "text-red-600" : undefined}>
        {found === true && !signed && (
          <button onClick={onSignIn} disabled={waiting} className={SMALL_DARK}>
            {waiting ? "Waiting…" : "Sign in"}
          </button>
        )}
      </SetupRow>
      {/* 3. The speech models (Claude voice hears and speaks on this computer) */}
      <SetupRow className="mt-2.5" done={m?.state === "ready"} title="Speech models" detail={modelsDetail(status, thisComputer)} detailClass={m?.state === "error" ? "text-amber-700" : undefined}>
        {m?.state === "error" && (
          <button onClick={onRetry} className="h-7 shrink-0 rounded-lg bg-white px-3 text-[12px] text-ink transition-colors hover:bg-black/[0.08] hover:text-fg">
            Retry
          </button>
        )}
      </SetupRow>
      {m?.state === "downloading" && (
        <div className="mt-2 ml-7 h-1 overflow-hidden rounded-full bg-black/[0.07]">
          <div className="h-full rounded-full bg-fg transition-[width] duration-700 ease-out" style={{ width: `${m.percent ?? 0}%` }} />
        </div>
      )}
    </>
  );
}

/** POST /api/key, as Settings' key field. The key is never shown or logged. */
function GrokSetup({ config, onSaved }: { config: AppConfig; onSaved: () => void }) {
  const saved = config.hasKey;
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const k = key.trim();
    if (!k) return;
    setError(null);
    const r = await postJson("/api/key", { key: k }).catch(() => null);
    if (r?.ok) {
      setKey("");
      setReplacing(false);
      onSaved();
    } else setError((r && (await r.json().catch(() => ({}))).error) || "Couldn't save it.");
  };
  return (
    <>
      <SetupRow done={saved} title="xAI API key" detail={saved ? `Saved, encrypted on ${thisComputer}` : null}>
        {saved && (
          <button onClick={() => setReplacing((x) => !x)} className="text-[12px] text-ink transition-colors hover:text-fg">
            {replacing ? "Cancel" : "Replace"}
          </button>
        )}
      </SetupRow>
      {(!saved || replacing) && (
        <>
          <form
            className="mt-2.5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              type="password"
              autoComplete="off"
              aria-label="xAI API key"
              placeholder="xai-…"
              className="h-[34px] min-w-0 flex-1 rounded-lg border border-line bg-white px-2.5 text-[13px] text-fg outline-none select-text placeholder:text-faint focus:border-black/40"
            />
            <button disabled={!key.trim()} className="h-[34px] shrink-0 rounded-lg bg-fg px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:opacity-30">
              Save
            </button>
          </form>
          <p className="mt-1.5 text-[11.5px] leading-snug text-muted">
            Get one at{" "}
            <a href="https://console.x.ai" target="_blank" rel="noreferrer" className="text-ink underline decoration-black/25 underline-offset-2 hover:decoration-fg">
              console.x.ai
            </a>{" "}
            → API Keys.
          </p>
          {error && <p className="mt-1 text-[11.5px] leading-snug text-red-600">{error}</p>}
        </>
      )}
    </>
  );
}
