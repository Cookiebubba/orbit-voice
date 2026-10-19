// The small API the Electron preload exposes. Undefined when the page runs in a normal browser.
import type { Phase } from "./useVoice";

export type OrbSync = { phase: Phase; input: number; output: number; asleep: boolean; hearing: boolean; claudeWorking: boolean; pulse: boolean };

/** "Pulse with your voice": the orb grows up to this much (6%) with your voice level. */
export const ORB_PULSE_MAX = 0.06;
export const orbScale = (input: number, pulse: boolean) => (pulse ? 1 + ORB_PULSE_MAX * Math.min(1, Math.max(0, input)) : 1);
/** Smooths the 20-per-second level steps into a swell (fast up, a little slower down feels natural too). */
export const ORB_PULSE_TRANSITION = "transform 120ms ease-out";

export type HotkeyInfo = {
  accelerator: string;
  label: string;
  registered: boolean;
  defaultAccelerator: string;
  ok?: boolean;
  error?: string;
};

type DesktopApi = {
  hotkey: {
    get(): Promise<HotkeyInfo>;
    set(accelerator: string): Promise<HotkeyInfo>;
    suspend(suspended: boolean): Promise<void>;
  };
  minimize(): void;
  close(): void;
  sendOrbState(s: OrbSync): void;
  onOrbState(cb: (s: OrbSync) => void): () => void;
  onOrbAction(cb: (action: "toggle-sleep") => void): () => void;
  orbRestore(): void;
  orbAction(action: "toggle-sleep"): void;
  /** Grok has the mic (for "mute my mic in other apps"). */
  micLive(live: boolean): void;
  orbDragStart(): void;
  orbDragMove(): void;
  orbDragEnd(): void;
  openLogs(): Promise<void>;
  startWithWindows: { get(): Promise<boolean>; set(enabled: boolean): Promise<boolean> };
  onHotkey(cb: () => void): () => void;
};

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export const desktop = typeof window !== "undefined" ? window.desktop : undefined;

/**
 * How visible the orb is: faint while asleep, half-lit while it waits in silence, and fully
 * lit while you talk to it (and while Grok thinks or answers).
 */
export function orbOpacity({ phase, asleep, hearing, input, claudeWorking = false }: Pick<OrbSync, "phase" | "asleep" | "hearing" | "input"> & { claudeWorking?: boolean }) {
  // While Claude works the orb is never dimmer than this, even with Grok off or asleep, so you
  // can tell at a glance that something is happening (the orange tiles say what).
  const floor = claudeWorking ? CLAUDE_WORKING_OPACITY : 0;
  if (phase === "off") return Math.max(0.55, floor);
  if (asleep) return Math.max(0.3, floor);
  if (hearing || phase === "speaking" || phase === "thinking" || phase === "connecting") return 1;
  return Math.max(0.6 + 0.4 * Math.min(1, input * 3), floor); // starts brightening as soon as you make a sound
}

const CLAUDE_WORKING_OPACITY = 0.85;

/** Map the voice phase onto the orb's three looks. */
export function orbProps(phase: Phase, input: number, output: number) {
  if (phase === "speaking") return { state: "speaking" as const, volumes: { input: 0, output } };
  if (phase === "thinking" || phase === "connecting") return { state: "thinking" as const };
  if (phase === "listening") return { state: "idle" as const, volumes: { input, output: 0 } };
  return { state: "idle" as const };
}
