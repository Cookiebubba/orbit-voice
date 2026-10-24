// Orbit's mouse: its shape and the colours the Settings preview shows (no imports, so the Settings
// page can use it without the engine). See look.js for the rest. The arrow is drawn as its fill
// only: one solid colour, no stroke or outline (Qubit's art rules).

/** The arrow, tip at (0, 0), in CSS px: 12 wide, 19 tall (Windows' arrow at 100%). */
export const ARROW_PATH = 'M0 0 L0 16.6 L4.1 12.9 L6.9 19.2 L9.5 18.1 L6.8 11.9 L12.2 11.9 Z';
export const ARROW_SIZE = Object.freeze({ w: 12.2, h: 19.2 });

/** The fill as CSS. */
export const css = ([l, c, h], a = 1) => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${(((h % 360) + 360) % 360).toFixed(1)}${a < 1 ? ` / ${a.toFixed(3)}` : ''})`;

/**
 * The states the Settings preview shows. Their colours are copied here so Settings needn't load the
 * whole engine; test/mouse.test.js checks they are the engine's own.
 */
export const PREVIEW = Object.freeze([
  { label: 'Listening', mode: 'listening', lch: [0.78, 0.13, 205] },
  { label: 'Thinking', mode: 'thinking', lch: [0.62, 0.22, 300] },
  { label: 'Speaking', mode: 'speaking', lch: [0.8, 0.15, 78] },
  { label: 'Watching Claude', mode: 'focused', lch: [0.7, 0.14, 42] },
  { label: 'Resting', mode: 'idle', lch: [0.63, 0.2, 272] },
]);
