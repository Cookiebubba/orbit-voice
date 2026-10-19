// The orb's look beyond Grok's own states: Claude-orange while Claude works (only while Grok is off
// or asleep: an active Grok keeps the orb's own colours), and the optional
// voice "bump". Tuned in the lab (ui/lab.html, `npm --prefix ui run dev`).
import type { Phase } from "./useVoice";

export const CLAUDE_WORKING_PARAMS: Record<string, number> = {
  accent: 1, // confetti tiles turn Claude orange
  confetti: 0.42, // and there are more of them (the orb's default is 0.22)
  tint: 0.12, // the lit tiles warm slightly toward orange
};

/** Bump amount limits: the ball's radius is 0.9 of the canvas, so up to 10% still fits. */
export const PULSE_MIN = 0.01;
export const PULSE_MAX = 0.1;
export const PULSE_DEFAULT = 0.05;

type Look = { claudeWorking: boolean; phase: Phase; asleep: boolean; pulseMe: boolean; pulseGrok: boolean; pulseAmount: number };

/**
 * Param overrides for the orb, or undefined for its normal look. While Grok is on (connected and
 * awake) it owns the orb, so Claude working doesn't recolour it; the orange returns when Grok
 * goes off or to sleep. The bump only applies while that
 * voice is really live (yours while Grok listens, Grok's while it speaks): in the other states
 * the orb's voice levels are synthesized, and it shouldn't bump on those.
 */
export function orbParams({ claudeWorking, phase, asleep, pulseMe, pulseGrok, pulseAmount }: Look): Record<string, number> | undefined {
  const amount = Math.min(PULSE_MAX, Math.max(0, pulseAmount || 0));
  const bumpIn = pulseMe && phase === "listening" && !asleep ? amount : 0;
  const bumpOut = pulseGrok && phase === "speaking" ? amount : 0;
  const orange = claudeWorking && (phase === "off" || asleep);
  if (!orange && !bumpIn && !bumpOut) return undefined;
  return { ...(orange ? CLAUDE_WORKING_PARAMS : {}), ...(bumpIn ? { bumpIn } : {}), ...(bumpOut ? { bumpOut } : {}) };
}
