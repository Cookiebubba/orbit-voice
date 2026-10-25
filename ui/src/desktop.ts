// The small API the Electron preload exposes. Undefined when the page runs in a normal browser.
import type { Phase } from "./useVoice";

export type OrbSync = {
  phase: Phase; input: number; output: number; asleep: boolean; hearing: boolean; claudeWorking: boolean;
  // Voice "bump" (see orbLook.ts): with your voice, with Grok's, and how much.
  pulseMe: boolean; pulseGrok: boolean; pulseAmount: number;
  // For the avatar: the mic is muted, a draft waits for a yes, a prompt is being sent.
  muted?: boolean; draft?: boolean; sending?: boolean;
};

export type HotkeyInfo = {
  accelerator: string;
  label: string;
  registered: boolean;
  defaultAccelerator: string;
  ok?: boolean;
  error?: string;
};

type DesktopApi = {
  /** process.platform of the desktop app ('win32', 'darwin', ...). */
  platform?: string;
  hotkey: {
    get(): Promise<HotkeyInfo>;
    set(accelerator: string): Promise<HotkeyInfo>;
    suspend(suspended: boolean): Promise<void>;
  };
  minimize(): void;
  close(): void;
  sendOrbState(s: OrbSync): void;
  /** Tell the avatar (pixel buddy or Qubit) something happened. */
  buddyEvent?(name: "finished" | "draft" | "sent" | "error"): void;
  onBuddyCommand?(cb: (c: { action: string; dir?: "left" | "right" }) => void): () => void;
  /** The avatar was clicked to talk (Settings -> Avatar -> Click your avatar to talk). */
  onAvatarTalk?(cb: () => void): () => void;
  /** A feeling as the voice's words play (an emote cue), for the avatar. */
  buddyEmote?(name: string): void;
  onOrbState(cb: (s: OrbSync) => void): () => void;
  onOrbAction(cb: (action: "toggle-sleep") => void): () => void;
  orbRestore(): void;
  orbAction(action: "toggle-sleep"): void;
  /** Grok has the mic (for "mute my mic in other apps"). */
  orbDragStart(): void;
  orbDragMove(): void;
  orbDragEnd(): void;
  openLogs(): Promise<void>;
  startWithWindows: { get(): Promise<boolean>; set(enabled: boolean): Promise<boolean> };
  onHotkey(cb: () => void): () => void;
  updates: {
    get(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    install(): Promise<boolean>;
    onChange(cb: (s: UpdateState) => void): () => void;
  };
};

/** The updater's state (electron/updater.js). */
export type UpdateState = {
  status: "dev" | "idle" | "checking" | "latest" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: number;
};

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export const desktop = typeof window !== "undefined" ? window.desktop : undefined;

/** Running on a Mac (the desktop app says so; in a browser, the browser's platform). */
export const isMac =
  desktop?.platform === "darwin" || (!desktop?.platform && typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || ""));
/** "this Mac" or "this PC", for "kept on this PC" and the like. */
export const thisComputer = isMac ? "this Mac" : "this PC";

/**
 * How visible the orb is. With no glow around it, brightness is the only sign of activity, so
 * every state sits on its own clearly different step:
 *   asleep 0.25 · off 0.35 · Claude working (Grok off) 0.6 · Grok listening 0.8 · you talking,
 *   Grok thinking or answering 1.
 * Grok listening is always brighter than Claude working alone, so you can tell it's on.
 */
export function orbOpacity({ phase, asleep, hearing, input, claudeWorking = false }: Pick<OrbSync, "phase" | "asleep" | "hearing" | "input"> & { claudeWorking?: boolean }) {
  if (phase === "off") return claudeWorking ? CLAUDE_WORKING_OPACITY : 0.35;
  if (asleep) return claudeWorking ? CLAUDE_WORKING_OPACITY : 0.25;
  if (hearing || phase === "speaking" || phase === "thinking" || phase === "connecting") return 1;
  return 0.8 + 0.2 * Math.min(1, input * 3); // listening; brightens as soon as you make a sound
}

const CLAUDE_WORKING_OPACITY = 0.6;

/** Map the voice phase onto the orb's three looks. */
export function orbProps(phase: Phase, input: number, output: number) {
  if (phase === "speaking") return { state: "speaking" as const, volumes: { input: 0, output } };
  if (phase === "thinking" || phase === "connecting") return { state: "thinking" as const };
  if (phase === "listening") return { state: "idle" as const, volumes: { input, output: 0 } };
  return { state: "idle" as const };
}
