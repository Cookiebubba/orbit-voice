// The small API the Electron preload exposes. Undefined when the page runs in a normal browser.
import type { Phase } from "./useVoice";

export type OrbSync = { phase: Phase; input: number; output: number; asleep: boolean; hearing: boolean; claudeWorking: boolean };

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
export function orbOpacity({ phase, asleep, hearing, input }: Pick<OrbSync, "phase" | "asleep" | "hearing" | "input">) {
  if (phase === "off") return 0.55;
  if (asleep) return 0.3;
  if (hearing || phase === "speaking" || phase === "thinking" || phase === "connecting") return 1;
  return 0.6 + 0.4 * Math.min(1, input * 3); // starts brightening as soon as you make a sound
}

/** Map the voice phase onto the orb's three looks. */
export function orbProps(phase: Phase, input: number, output: number) {
  if (phase === "speaking") return { state: "speaking" as const, volumes: { input: 0, output } };
  if (phase === "thinking" || phase === "connecting") return { state: "thinking" as const };
  if (phase === "listening") return { state: "idle" as const, volumes: { input, output: 0 } };
  return { state: "idle" as const };
}
