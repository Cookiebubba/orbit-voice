import { useEffect, useRef, useState } from "react";
import { History as HistoryIcon, Keyboard, Mic, Minus, Moon, SendHorizontal, Settings as SettingsIcon, X } from "lucide-react";
import { Shdr29 } from "@/components/ui/shdr-29";
import { cn } from "@/lib/utils";
import DraftCard from "./components/DraftCard";
import History from "./components/History";
import SessionSwitcher from "./components/SessionSwitcher";
import { desktop, orbOpacity, orbProps } from "./desktop";
import { PULSE_DEFAULT, orbParams } from "./orbLook";
import Settings from "./Settings";
import { playChime } from "./sounds";
import { postJson, useAppState, type Finished } from "./useAppState";
import { useVoice, type Phase } from "./useVoice";
import { useWakeWord } from "./useWakeWord";

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
  const app = useAppState({ onFinished: (f) => finishedRef.current(f) });
  const settings = app.config?.settings;
  const v = useVoice({ listenMode: settings?.listenMode ?? "always", halfDuplex: settings?.halfDuplex ?? false });
  // "Hey Grok": offline, and only while Grok is off or asleep. Same effect as the hotkey.
  const { status: wakeStatus, element: wakeFrame } = useWakeWord({
    enabled: !!settings?.wakeWord && !!app.config?.hasKey && (v.phase === "off" || v.asleep),
    onWake: () => v.hotkey(),
  });
  const wakeOn = wakeStatus === "listening";
  const [view, setView] = useState<View>("main");
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const hotkey = settings?.hotkeyLabel ?? "Ctrl+Alt+G";
  const tap = settings?.listenMode === "tap";
  const workingTitles = new Set(app.claudeWorking.map((w) => w.title));
  const claudeWorking = app.claudeWorking.length > 0;
  const pulse = { pulseMe: !!settings?.orbPulse, pulseGrok: !!settings?.orbPulseGrok, pulseAmount: settings?.orbPulseAmount ?? PULSE_DEFAULT };

  // Claude finished a turn somewhere: chime, note it, and pop a Windows notification if we're not in front.
  finishedRef.current = (f) => {
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

  // Keep the floating orb in sync with this window.
  useEffect(() => {
    desktop?.sendOrbState({ phase: v.phase, input: v.levels.input, output: v.levels.output, asleep: v.asleep, hearing: v.hearing, claudeWorking, ...pulse });
  }, [v.phase, v.levels, v.asleep, v.hearing, claudeWorking, pulse.pulseMe, pulse.pulseGrok, pulse.pulseAmount]);

  // Right-clicking the floating orb toggles sleep; the global hotkey starts / sleeps / wakes.
  const actions = useRef(v);
  actions.current = v;
  useEffect(() => desktop?.onOrbAction((a) => a === "toggle-sleep" && actions.current.toggleSleep()), []);
  useEffect(() => desktop?.onHotkey(() => actions.current.hotkey()), []);

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
  const recent = v.captions.filter((c) => c.who !== "note" || c === v.captions[v.captions.length - 1]).slice(-3);
  // Connected but not listening: Grok is finishing its goodbye before hanging up, or ("one
  // question" mode) answering / holding a draft that waits for your yes.
  const waitingForYes = v.asleep && tap && !!v.draft;
  const asleepLabel = waitingForYes ? "Waiting for your answer" : tap ? "Answering" : "Going to sleep…";
  const say = wakeOn ? "Say “Hey Grok” or press" : "Press";
  const hint = !on ? (wakeOn ? `Say “Hey Grok” or press ${hotkey}` : `Tap the orb or press ${hotkey}`) : waitingForYes ? `${say} ${hotkey} to answer` : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-black text-white select-none">
      {wakeFrame}
      {/* title bar: draggable in the desktop app */}
      <div className="flex h-10 shrink-0 items-center gap-1 pr-1 pl-4 [-webkit-app-region:drag]">
        <span className="mr-1 text-[13px] font-semibold tracking-tight">Orbit</span>
        <SessionSwitcher
          current={v.sessionTitle}
          workingTitles={workingTitles}
          onSwitched={(title) => v.setSessionTitle(title)}
          onAsk={(title) => {
            setView("main");
            v.ask(`What's happening in my Claude session called "${title}"?`);
          }}
        />
        <div className="ml-auto flex [-webkit-app-region:no-drag]">
          <TitleButton label="History" active={view === "history"} onClick={() => setView((x) => (x === "history" ? "main" : "history"))}>
            <HistoryIcon size={14} />
          </TitleButton>
          <TitleButton label="Settings" active={view === "settings"} onClick={() => setView((x) => (x === "settings" ? "main" : "settings"))}>
            <SettingsIcon size={14} />
          </TitleButton>
          {desktop && (
            <>
              <TitleButton label="Shrink to orb" onClick={() => desktop?.minimize()}>
                <Minus size={15} />
              </TitleButton>
              <TitleButton label="Quit" onClick={() => desktop?.close()} danger>
                <X size={15} />
              </TitleButton>
            </>
          )}
        </div>
      </div>

      {view === "settings" ? (
        <Settings config={app.config} update={app.updateSettings} onClose={() => setView("main")} />
      ) : view === "history" ? (
        <History items={v.captions} onClose={() => setView("main")} />
      ) : !app.config.hasKey ? (
        <KeySetup onSaved={app.setHasKey} />
      ) : (
        <>
          {/* orb + status */}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5">
            <button
              aria-label={!on ? "Start talking" : v.asleep ? "Wake up" : "Voice is on"}
              onClick={() => (!on ? v.start() : v.asleep && v.wake())}
              className={cn("relative rounded-full transition-opacity duration-300", (!on || v.asleep) && "cursor-pointer")}
            >
              <span
                className="block"
                style={{
                  opacity: orbOpacity({ phase: v.phase, asleep: v.asleep, hearing: v.hearing, input: v.levels.input, claudeWorking }),
                  transition: "opacity 300ms",
                }}
              >
                <Shdr29 size={190} {...orbProps(v.phase, v.levels.input, v.levels.output)} params={orbParams({ claudeWorking, phase: v.phase, asleep: v.asleep, ...pulse })} pauseOffscreen={false} />
              </span>
            </button>
            <div className="mt-5 text-[15px] font-medium tracking-tight">{v.asleep && on ? asleepLabel : PHASE_LABEL[v.phase]}</div>
            {desktop && hint && <div className="mt-1 text-[12px] text-white/40">{hint}</div>}
            {claudeWorking && (
              <div className="mt-2 flex max-w-full items-center gap-1.5 text-[12px] text-white/50">
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
                    c.who === "error" ? "text-amber-400" : c.who === "you" ? "text-white/45" : c.who === "sent" ? "text-emerald-300/80" : "text-white/70",
                    i === recent.length - 1 && c.who === "grok" && "text-white/90",
                  )}
                >
                  {c.who === "sent" ? `Sent to Claude ✓ ${c.text}` : c.text}
                </p>
              ))}
            </div>
          </div>

          {v.draft && <DraftCard draft={v.draft} onSend={() => v.sendDraft(v.draft!.id)} onDiscard={() => v.discardDraft(v.draft!.id)} onEdit={(text) => v.editDraft(v.draft!.id, text)} />}

          {typing && on && (
            <form
              className="mx-4 mb-3 flex items-center rounded-full border border-white/15 bg-white/[0.06] pr-1 pl-4"
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
                placeholder="Type to Grok…"
                className="h-9 flex-1 bg-transparent text-[13px] outline-none select-text placeholder:text-white/35"
              />
              <button aria-label="Send" className="grid size-7 place-items-center rounded-full bg-white text-black disabled:opacity-30" disabled={!text.trim()}>
                <SendHorizontal size={14} />
              </button>
            </form>
          )}

          {/* controls */}
          <div className="flex h-20 shrink-0 items-center justify-center gap-3">
            {on ? (
              <>
                <RoundButton label="Type instead" active={typing} onClick={() => setTyping((t) => !t)}>
                  <Keyboard size={18} />
                </RoundButton>
                <RoundButton
                  label={waitingForYes ? `Answer (${hotkey})` : `Go to sleep: hangs up (${hotkey})`}
                  active={waitingForYes}
                  onClick={v.toggleSleep}
                  big
                >
                  {waitingForYes ? <Mic size={22} /> : <Moon size={21} />}
                </RoundButton>
              </>
            ) : (
              <button onClick={v.start} className="flex h-11 items-center gap-2 rounded-full bg-white px-5 text-[14px] font-medium text-black hover:bg-white/90">
                <Mic size={17} /> Start talking
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-screen place-items-center bg-black p-6 text-center text-[13px] text-white/60">{children}</div>;
}

function TitleButton(props: { label: string; onClick: () => void; danger?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-md text-white/60 hover:text-white",
        props.active && "bg-white/10 text-white",
        props.danger ? "hover:bg-red-600" : "hover:bg-white/10",
      )}
    >
      {props.children}
    </button>
  );
}

function RoundButton(props: { label: string; onClick: () => void; active?: boolean; danger?: boolean; big?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={cn(
        "grid place-items-center rounded-full transition-colors",
        props.big ? "size-14" : "size-11",
        props.danger ? "bg-white/[0.08] text-red-400 hover:bg-red-500/20" : props.active ? "bg-white text-black" : "bg-white/[0.08] text-white hover:bg-white/15",
      )}
    >
      {props.children}
    </button>
  );
}

function KeySetup({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-1 flex-col justify-center gap-3 px-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        const r = await postJson("/api/key", { key });
        if (r.ok) onSaved();
        else setError((await r.json().catch(() => ({}))).error || "Could not save the key.");
      }}
    >
      <h2 className="text-[17px] font-semibold tracking-tight">Welcome to Orbit</h2>
      <p className="text-[13px] leading-relaxed text-white/60">
        Orbit uses Grok Voice from xAI. Paste your xAI API key to start. Get one at{" "}
        <a href="https://console.x.ai" target="_blank" rel="noreferrer" className="text-white underline underline-offset-2">
          console.x.ai
        </a>{" "}
        → API Keys. It's stored encrypted, only on this computer.
      </p>
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        type="password"
        placeholder="xai-…"
        autoComplete="off"
        className="h-10 rounded-xl border border-white/15 bg-white/[0.06] px-3 text-[13px] outline-none select-text focus:border-white/40"
      />
      {error && <p className="text-[12px] text-amber-400">{error}</p>}
      <button disabled={!key.trim()} className="h-10 rounded-full bg-white text-[14px] font-medium text-black disabled:opacity-30">
        Save key
      </button>
    </form>
  );
}
