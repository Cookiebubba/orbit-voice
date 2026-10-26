import { useEffect, useRef, useState } from "react";
import { History as HistoryIcon, Keyboard, Mic, MicOff, Minus, Moon, SendHorizontal, Settings as SettingsIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import History from "./components/History";
import SessionSwitcher from "./components/SessionSwitcher";
import { desktop } from "./desktop";
import { PULSE_DEFAULT } from "./orbLook";
import AvatarHero from "./hero/AvatarHero";
import Settings from "./Settings";
import { playChime } from "./sounds";
import { DEFAULT_VOLUME, volumeGain } from "./playback.js";
import { createThrowSound } from "./throwSound.js";
import { hotkeyLabel, postJson, useAppState, type Finished } from "./useAppState";
import { useVoice, type Phase } from "./useVoice";
import { useWakeWord } from "./useWakeWord";
import { canTalk, checkClaudeAgain, claudeVoiceReady, needsModelDownload, screenFor, talkNotice, type ClaudeVoiceReady, type TalkBlocked } from "./talk.js";
import { InstallCommand, NotSignedInLine, SetupGuideLink, SignInStep } from "./components/ClaudeSetup";

const PHASE_LABEL: Record<Phase, string> = {
  off: "Sleeping", // hung up: nothing is billed until you start again
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

type View = "main" | "settings" | "history";

export default function App() {
  const finishedRef = useRef<(f: Finished) => void>(() => {});
  const wakeRef = useRef<() => void>(() => {});
  const app = useAppState({ onFinished: (f) => finishedRef.current(f), onWake: () => wakeRef.current() });
  const settings = app.config?.settings;
  const v = useVoice({ listenMode: settings?.listenMode ?? "always", halfDuplex: settings?.halfDuplex ?? false, volume: settings?.voiceVolume ?? DEFAULT_VOLUME });
  // Claude voice needs no key; Grok voice needs an xAI key (asked for inline, only when you try).
  const talkable = canTalk(app.config);
  const hotkeyRef = useRef(() => {}); // the hotkey's (and the wake word's) action, set below
  // "Hey Orbit" / "Hey Grok": offline, and only while Grok is off or asleep. Same effect as the hotkey.
  const { status: wakeStatus, element: wakeFrame } = useWakeWord({
    enabled: !!settings?.wakeWord && talkable && (v.phase === "off" || v.asleep),
    onWake: () => hotkeyRef.current(),
  });
  const wakeOn = wakeStatus === "listening";
  const [view, setView] = useState<View>("main");
  const [focusKey, setFocusKey] = useState(false); // Settings opened from the "needs an xAI key" notice
  // A try to talk that couldn't start: why, and (Claude voice) its readiness as last checked.
  const [blocked, setBlocked] = useState<TalkBlocked>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeVoiceReady | null>(null);
  const claudeReady = useRef(false); // checked once per run: then calls start straight away
  const notice = talkNotice(blocked, app.config, claudeStatus);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const hotkey = settings?.hotkeyLabel ?? hotkeyLabel("Control+Alt+G");
  const tap = settings?.listenMode === "tap";
  const workingTitles = new Set(app.claudeWorking.map((w) => w.title));
  const claudeWorking = app.claudeWorking.length > 0;
  const pulse = { pulseMe: !!settings?.orbPulse, pulseGrok: !!settings?.orbPulseGrok, pulseAmount: settings?.orbPulseAmount ?? PULSE_DEFAULT };

  // Claude finished a turn somewhere: chime, note it, and pop a system notification if we're not in front.
  finishedRef.current = (f) => {
    desktop?.buddyEvent?.("finished"); // the avatar celebrates (or jolts awake)
    const mode = settings?.announce ?? "speak";
    if (mode === "off") return;
    playChime("done", 0.1);
    v.note(`Claude finished in “${f.title}”`);
    if ((document.hidden || !document.hasFocus()) && "Notification" in window) {
      try {
        new Notification(`Claude finished: ${f.title}`, { body: f.summary.slice(0, 180), silent: true });
      } catch {}
    }
  };

  // The bridge asks Grok to wake by itself ("Wake Grok to say it", or something you asked for is
  // ready). It checks the settings, spacing and hourly limit; this only connects if Grok is off.
  wakeRef.current = () => {
    if (talkable) v.announce();
  };

  /**
   * Start a call by `go` (start, the hotkey's start, an ask), if it can start: Grok without a key,
   * or Claude voice not ready yet (Claude Code missing, speech models not here), shows a short
   * notice on the main page instead (and the models' download starts). `engine` overrides the
   * saved one (just switched to Claude).
   */
  const tryTalk = async (go: () => void, engine = settings?.voiceEngine) => {
    if (engine !== "claude") {
      if (!canTalk(app.config)) return setBlocked("grok-key");
      setBlocked(null);
      return go();
    }
    if (claudeReady.current) {
      setBlocked(null);
      return go();
    }
    let st: ClaudeVoiceReady | null = await fetch("/api/claude-voice")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (claudeVoiceReady(st)) {
      claudeReady.current = true;
      setBlocked(null);
      return go();
    }
    if (!st) {
      setBlocked(null);
      return go(); // couldn't check: the bridge says what's wrong, if anything
    }
    if (st.signedIn !== false && needsModelDownload(st)) {
      const r = await postJson("/api/claude-voice/download", {})
        .then((x) => x.json())
        .catch(() => null);
      if (r?.models) st = { ...st, models: r.models };
    }
    setClaudeStatus(st);
    setBlocked("claude");
  };
  // While the speech models download, follow their progress (the notice goes when they're ready).
  const modelsLoading = notice?.kind === "claude-models";
  useEffect(() => {
    if (!modelsLoading) return;
    const id = setInterval(() => {
      fetch("/api/claude-voice")
        .then((r) => r.json())
        .then((st: ClaudeVoiceReady) => {
          if (claudeVoiceReady(st)) claudeReady.current = true;
          setClaudeStatus(st);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [modelsLoading]);
  // The notice's "Check again" (Claude Code missing or signed out): look again; found and ready
  // clears the notice, otherwise it follows what was found (the models' download starts if needed).
  const [checking, setChecking] = useState<"idle" | "checking" | "still">("idle");
  const checkAgain = async () => {
    setChecking("checking");
    const before = notice?.kind;
    const r = await checkClaudeAgain({
      fetchStatus: () => fetch("/api/claude-voice").then((x) => (x.ok ? x.json() : null)),
      startDownload: () => postJson("/api/claude-voice/download", {}).then((x) => x.json()),
    });
    if (r.ready) {
      claudeReady.current = true;
      setBlocked(null);
    } else if (r.status) setClaudeStatus(r.status);
    const after = r.ready ? null : talkNotice("claude", app.config, r.status ?? claudeStatus)?.kind;
    setChecking(after && after === before ? "still" : "idle");
  };
  useEffect(() => setChecking("idle"), [notice?.kind]);

  // The avatar (pixel buddy or Qubit) carries each new draft to Claude's box, stomps Send when it
  // goes, and (Qubit) shivers at an error.
  useEffect(() => {
    if (v.draft) desktop?.buddyEvent?.("draft");
  }, [v.draft?.id]);
  useEffect(() => {
    if (v.sentCount) desktop?.buddyEvent?.("sent");
  }, [v.sentCount]);
  useEffect(() => {
    if (v.errorCount) desktop?.buddyEvent?.("error");
  }, [v.errorCount]);

  // Keep the floating orb (and the avatar) in sync with this window.
  const draftWaiting = !!v.draft;
  useEffect(() => {
    desktop?.sendOrbState({ phase: v.phase, input: v.levels.input, output: v.levels.output, asleep: v.asleep, hearing: v.hearing, claudeWorking, muted: v.muted, draft: draftWaiting, sending: v.sending, ...pulse });
  }, [v.phase, v.levels, v.asleep, v.hearing, claudeWorking, v.muted, draftWaiting, v.sending, pulse.pulseMe, pulse.pulseGrok, pulse.pulseAmount]);

  // Right-clicking the floating orb toggles sleep; the global hotkey starts / sleeps / wakes.
  const actions = useRef(v);
  actions.current = v;
  // The hotkey (and the wake word, the orb): hung up, it starts a call (if one can start); in a
  // call, it sleeps / wakes as before.
  hotkeyRef.current = () => {
    if (v.phase === "off") void tryTalk(() => actions.current.hotkey());
    else v.hotkey();
  };
  useEffect(() => desktop?.onOrbAction((a) => a === "toggle-sleep" && hotkeyRef.current()), []);
  useEffect(() => desktop?.onHotkey(() => hotkeyRef.current()), []);
  // A click on the avatar: the wake word's own path (Orbit off or asleep). Already awake, the
  // avatar's little nod is all. Grok without a key: the notice on the main page says why.
  const talkRef = useRef(() => {});
  talkRef.current = () => {
    if (v.phase === "off" || v.asleep) hotkeyRef.current();
  };
  useEffect(() => desktop?.onAvatarTalk?.(() => talkRef.current()), []);
  // Qubit thrown for real: "Wheee!" at the voice volume, once (a new throw restarts it), awake or
  // asleep; while it plays Orbit's listening treats it like its own voice.
  const throwSound = useRef(createThrowSound({ gain: volumeGain }));
  const soundRef = useRef((_name: string) => {});
  soundRef.current = (name) => {
    if (name !== "throw" || settings?.avatarThrow === false || settings?.avatarThrowSound === false) return;
    v.ownSound(throwSound.current.play(settings?.voiceVolume ?? DEFAULT_VOLUME));
  };
  useEffect(() => desktop?.onAvatarSound?.((name) => soundRef.current(name)), []);

  // Show which session is open in Claude straight away, and again whenever this window comes back.
  useEffect(() => {
    const refresh = () =>
      fetch("/api/sessions")
        .then((r) => r.json())
        .then((d) => d.openInApp && actions.current.setSessionTitle(d.openInApp))
        .catch(() => {});
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  if (app.failed) return <Centered>Orbit isn't signed in to its local bridge. Close this and open Orbit again (or, in browser mode, use the link printed in the terminal).</Centered>;
  if (!app.config) return <Centered>Loading…</Centered>;

  const on = v.phase !== "off";
  const screen = screenFor(view); // never a key screen: the main page shows with or without a key
  const startTalk = () => void tryTalk(() => v.start());
  const openSettings = () => {
    setFocusKey(notice?.kind === "grok-key");
    setView("settings");
  };
  const switchToClaude = async () => {
    setBlocked(null);
    await app.updateSettings({ voiceEngine: "claude" });
    void tryTalk(() => v.start(), "claude");
  };
  const recent = v.captions.filter((c) => c.who !== "note" || c === v.captions[v.captions.length - 1]).slice(-3);
  // Connected but not listening: Grok is finishing its goodbye before hanging up, or ("one
  // question" mode) answering / holding a draft that waits for your yes.
  const waitingForYes = v.asleep && tap && !!v.draft;
  const asleepLabel = waitingForYes ? "Waiting for your answer" : tap ? "Answering" : "Going to sleep…";
  const say = wakeOn ? "Say “Hey Orbit” or press" : "Press";
  const hint = !on ? (wakeOn ? `Say “Hey Orbit” or press ${hotkey}` : `Click Qubit or press ${hotkey}`) : waitingForYes ? `${say} ${hotkey} to answer` : null;

  // Orbit's state for the hero (his colour and eye follow it while Orbit is live).
  const heroVoice = { phase: v.phase, asleep: v.asleep, hearing: v.hearing, input: v.levels.input, output: v.levels.output, muted: v.muted, draft: draftWaiting, sending: v.sending, claudeWorking };
  const heroLabel = !on ? "Start talking" : v.asleep ? "Wake up" : "Voice is on";
  const status = v.asleep && on ? asleepLabel : v.muted && on && v.phase === "listening" ? "Muted" : PHASE_LABEL[v.phase];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-fg select-none">
      {wakeFrame}
      {/* title bar: draggable in the desktop app (on a Mac the traffic lights sit at its left) */}
      <div className={cn("flex h-11 shrink-0 items-center gap-1.5 pr-1.5 [-webkit-app-region:drag]", "pl-4")}>
        <span className="wordmark mr-1 text-[19px]">Orbit</span>
        <SessionSwitcher
          current={v.sessionTitle}
          workingTitles={workingTitles}
          onSwitched={(title) => v.setSessionTitle(title)}
          onAsk={(title) => {
            setView("main");
            const ask = () => v.ask(`What's happening in my Claude session called "${title}"?`);
            if (on) ask();
            else void tryTalk(ask);
          }}
        />
        <div className="ml-auto flex [-webkit-app-region:no-drag]">
          <TitleButton label="History" active={view === "history"} onClick={() => setView((x) => (x === "history" ? "main" : "history"))}>
            <HistoryIcon size={15} />
          </TitleButton>
          <TitleButton label="Settings" active={view === "settings"} onClick={() => setView((x) => (x === "settings" ? "main" : "settings"))}>
            <SettingsIcon size={15} />
          </TitleButton>
          {desktop && (
            <>
              <TitleButton label="Shrink to orb" onClick={() => desktop?.minimize()}>
                <Minus size={16} />
              </TitleButton>
              <TitleButton label="Quit" onClick={() => desktop?.close()} danger>
                <X size={16} />
              </TitleButton>
            </>
          )}
        </div>
      </div>

      {screen === "settings" ? (
        <Settings
          config={app.config}
          update={app.updateSettings}
          onKeySaved={app.setHasKey}
          focusKey={focusKey}
          onClose={() => {
            setFocusKey(false);
            setView("main");
          }}
        />
      ) : screen === "history" ? (
        <History items={v.captions} onClose={() => setView("main")} />
      ) : (
        <>
          {/* the hero: the avatar carousel, Qubit in the middle, then what Orbit is doing */}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5">
            <AvatarHero
              avatar={settings?.avatar}
              onChoose={(avatar) => app.updateSettings({ avatar })}
              voice={heroVoice}
              label={heroLabel}
              onActivate={() => (!on ? startTalk() : v.endWake() || (v.asleep && v.wake()))}
            />
            <div className="mt-5 text-[16px] font-semibold tracking-[-0.02em]">{status}</div>
            {desktop && hint && !notice && <div className="mt-1.5 text-center font-mono text-[11px] leading-snug text-muted">{hint}</div>}
            {notice && !on && (
              <div role="status" className="mt-2 flex max-w-[320px] flex-col items-center gap-2 text-center">
                {notice.kind === "claude-signed-out" ? (
                  <NotSignedInLine />
                ) : (
                  <p className={cn("text-[12.5px] leading-snug", notice.kind === "claude-models" ? "text-ink" : "text-amber-700")}>{notice.text}</p>
                )}
                {notice.kind === "claude-missing" && (
                  <>
                    <InstallCommand />
                    <SignInStep className="w-full text-left" />
                  </>
                )}
                {checking === "still" && <p className="text-[12px] leading-snug text-muted">{notice.kind === "claude-missing" ? "Still not found. If it just finished installing, give it a moment." : "Still not signed in."}</p>}
                {notice.kind !== "claude-models" && (
                  <div className="flex flex-wrap justify-center gap-2">
                    {(notice.kind === "claude-missing" || notice.kind === "claude-signed-out") && (
                      <NoticeButton onClick={checkAgain} disabled={checking === "checking"}>
                        {checking === "checking" ? "Checking…" : "Check again"}
                      </NoticeButton>
                    )}
                    {notice.kind === "claude-missing" && <SetupGuideLink className={NOTICE_BUTTON} />}
                    <NoticeButton onClick={openSettings}>Open Settings</NoticeButton>
                    {notice.kind === "grok-key" && <NoticeButton onClick={switchToClaude}>Use Claude voice</NoticeButton>}
                    {notice.kind === "claude-models-error" && <NoticeButton onClick={startTalk}>Try again</NoticeButton>}
                  </div>
                )}
              </div>
            )}
            {claudeWorking && (
              <div className="mt-2 flex max-w-full items-center gap-1.5 text-[12px] text-ink">
                <span className="working-dot" aria-hidden />
                <span className="truncate">Claude is working{app.claudeWorking.length === 1 ? ` in ${app.claudeWorking[0].title}` : ` in ${app.claudeWorking.length} sessions`}</span>
              </div>
            )}
            <div className="mt-3 flex min-h-16 w-full flex-col items-center gap-1 text-center">
              {recent.map((c, i) => (
                <p
                  key={c.id}
                  className={cn(
                    "line-clamp-2 text-[13px] leading-snug",
                    c.who === "error" ? "text-amber-700" : c.who === "you" ? "text-faint" : c.who === "sent" ? "text-emerald-700" : "text-muted",
                    i === recent.length - 1 && c.who === "grok" && "text-fg",
                  )}
                >
                  {c.who === "sent" ? `Sent to Claude ✓ ${c.text}` : c.text}
                </p>
              ))}
            </div>
          </div>

          {typing && on && (
            <form
              className="mx-4 mb-2 flex items-center rounded-full bg-soft pr-1 pl-4"
              onSubmit={(e) => {
                e.preventDefault();
                v.sendText(text.trim());
                setText("");
              }}
            >
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={settings?.voiceEngine === "claude" ? "Type to Orbit…" : "Type to Grok…"}
                className="h-10 flex-1 bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-faint"
              />
              <button aria-label="Send" title="Send" className="grid size-8 place-items-center rounded-full bg-fg text-white disabled:opacity-25" disabled={!text.trim()}>
                <SendHorizontal size={14} />
              </button>
            </form>
          )}

          {/* controls: only their icons. Sleep in the middle (big), typing on its left, mute on its right. */}
          <div className="flex h-[72px] shrink-0 items-center justify-center gap-7 pb-1">
            {on ? (
              <>
                <IconButton label="Type instead" active={typing} onClick={() => setTyping((t) => !t)}>
                  <Keyboard size={21} />
                </IconButton>
                <IconButton label={waitingForYes ? `Answer (${hotkey})` : `Go to sleep: hangs up (${hotkey})`} active={waitingForYes} onClick={v.toggleSleep} big>
                  {waitingForYes ? <Mic size={27} /> : <Moon size={26} />}
                </IconButton>
                <IconButton label={v.muted ? "Unmute microphone" : "Mute microphone"} danger={v.muted} onClick={v.toggleMute}>
                  {v.muted ? <MicOff size={21} /> : <Mic size={21} />}
                </IconButton>
              </>
            ) : (
              <IconButton label="Start talking" onClick={startTalk} big active>
                <Mic size={27} />
              </IconButton>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-screen place-items-center bg-white p-6 text-center text-[13px] text-muted">{children}</div>;
}

function TitleButton(props: { label: string; onClick: () => void; danger?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:text-fg",
        props.active && "bg-soft text-fg",
        props.danger ? "hover:bg-red-600 hover:text-white" : "hover:bg-soft",
      )}
    >
      {props.children}
    </button>
  );
}

/** A bottom-bar control: only its icon (no stroke, no fill), with its name as a tooltip. */
function IconButton(props: { label: string; onClick: () => void; active?: boolean; danger?: boolean; big?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      data-active={!!props.active}
      data-danger={!!props.danger}
      className={cn("icon-btn", props.big ? "size-12" : "size-10")}
    >
      {props.children}
    </button>
  );
}

/** A small pill button in the main page's notice (the same look as Settings' small buttons). */
const NOTICE_BUTTON = "rounded-full bg-soft px-3 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-black/[0.08] hover:text-fg disabled:opacity-50";
function NoticeButton(props: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={props.onClick} disabled={props.disabled} className={NOTICE_BUTTON}>
      {props.children}
    </button>
  );
}
