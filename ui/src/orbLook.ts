// How the orb looks while Claude is working: Claude-orange tiles flowing through it, faded in and
// out by the orb's own glide (no pulsing). Tuned in the lab (ui/lab.html, `npm --prefix ui run dev`).
export const CLAUDE_WORKING_PARAMS: Record<string, number> = {
  accent: 1, // confetti tiles turn Claude orange
  confetti: 0.42, // and there are more of them (the orb's default is 0.22)
  tint: 0.12, // the lit tiles warm slightly toward orange
};

/** Param overrides for the orb, or undefined for its normal look. */
export const orbLookParams = (claudeWorking: boolean) => (claudeWorking ? CLAUDE_WORKING_PARAMS : undefined);
