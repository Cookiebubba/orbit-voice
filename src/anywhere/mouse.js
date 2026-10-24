// Orbit's mouse, the shared core: where a control is on screen, whether the user could see Orbit's
// cursor there, and telling the desktop shell's overlay (electron/orbit-mouse.js, the "sink") to glide
// there. Two uses:
//   - pointAt: "show me where to click" (the point_at tool). The cursor glides to the control and
//     rests on it for a few seconds. It never clicks. Read-only.
//   - leadIn: every act (hands.js perform) first glides the cursor to its control and presses there,
//     so Orbit's background acts are visible, while the real input still goes through UI Automation
//     or the app's pipe, never the user's mouse. Bounded: an act waits about the lead time
//     (Settings anywhereMouseLeadMs, 220 ms by default) and never on anything slow.
//
// Where a control is: its UI Automation scan rect (`r`, physical pixels), or, for an app under Orbit
// (keeper.js), the element's place in the page through the pipe (cdpElementRect, without scrolling
// the page), placed by the page area UI Automation reports. Shown only where the user would see it:
// the window not minimized or on another desktop, the control inside the window and on a display, and
// that window (not another one covering it) at the control's middle (uia.ps1 "hit").

import { getSetting } from '../config.js';
import { uiaRequest } from '../platform/index.js';
import { cdpElementRect } from './cdp.js';
import { keeperForWindow } from './keeper.js';

export const MOUSE = Object.freeze({ leadMs: 220, leadMaxMs: 600, pointMs: 3500, holdAfterActMs: 1400, lookupMs: 300, cdpPointMs: 1500, cdpLeadMs: 220, hitMs: 400 });

let sink = null; // { glide, press, hide, onScreen }
/** The desktop shell's overlay (or null): electron/orbit-mouse.js. */
export function setMouseSink(s) {
  sink = s && typeof s.glide === 'function' ? s : null;
}
/** Is Orbit's mouse on (the setting, and an overlay to draw it)? */
export const mouseOn = () => !!sink && getSetting('anywhereMouse') !== false;
/** How long an act's lead-in glide takes (ms). */
export function leadMs() {
  const v = Number(getSetting('anywhereMouseLeadMs'));
  return Number.isFinite(v) ? Math.min(MOUSE.leadMaxMs, Math.max(0, Math.round(v))) : MOUSE.leadMs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), sleep(ms).then(() => null)]);
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** A scan node's rect ({ x, y, w, h }, physical px), or null if it has none worth pointing at. */
export function rectOfNode(node) {
  const r = node?.r;
  if (!Array.isArray(r) || r.length < 4) return null;
  const [x, y, w, h] = r.map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/** The web page's area in a scan (the biggest Document node), for placing page elements on screen. */
export function pageRect(scan) {
  let best = null;
  for (const n of scan?.nodes || []) {
    if (n.t !== 'Document') continue;
    const r = rectOfNode(n);
    if (r && (!best || r.w * r.h > best.w * best.h)) best = r;
  }
  return best;
}

/**
 * Where the control is on screen: { rect, via: 'uia' | 'pipe', inView } or null. For an app under
 * Orbit, the page's own geometry (through the pipe) when it answers within `cdpMs`; else UI
 * Automation's rect.
 */
export async function controlRect({ win, node, scan }, { cdpMs = MOUSE.cdpPointMs, cdp = cdpElementRect, underOrbit = keeperForWindow } = {}) {
  const uia = rectOfNode(node);
  if (underOrbit(win) && (node?.n || node?.a)) {
    const r = await withTimeout(cdp(win, { name: node.n || node.a, contentRect: pageRect(scan), scroll: false }), cdpMs);
    if (r?.ok && r.rect?.w > 0 && r.rect?.h > 0) return { rect: r.rect, via: 'pipe', inView: r.inView !== false };
  }
  return uia ? { rect: uia, via: 'uia', inView: !node.off } : null;
}

/** Where in the window a rect is, in words: "top right", "bottom left", "middle"... */
export function whereIn(rect, winRect) {
  if (!rect || !(winRect?.w > 0) || !(winRect?.h > 0)) return '';
  const c = center(rect);
  const fx = (c.x - winRect.x) / winRect.w;
  const fy = (c.y - winRect.y) / winRect.h;
  const v = fy < 1 / 3 ? 'top' : fy > 2 / 3 ? 'bottom' : '';
  const h = fx < 1 / 3 ? 'left' : fx > 2 / 3 ? 'right' : '';
  return [v, h].filter(Boolean).join(' ') || 'middle';
}

/**
 * Could the user see Orbit's cursor on this rect of this window? { ok: true } or { ok: false, why }
 * ('minimized' | 'hidden' | 'scrolled_away' | 'off_screen' | 'covered'). `hit` (tests) stands in for
 * uia.ps1's hit test; an Orbit window of our own at the point (the orb, an avatar) doesn't count.
 */
export async function seenAt(win, rect, { hit = (args) => uiaRequest('hit', args, { timeoutMs: MOUSE.hitMs }), selfPid = process.pid, onScreen = (p) => (sink?.onScreen ? sink.onScreen(p) : true) } = {}) {
  if (win?.min) return { ok: false, why: 'minimized' };
  if (win?.cloaked) return { ok: false, why: 'hidden' };
  const c = center(rect);
  const wr = win?.rect;
  if (wr?.w > 0 && wr?.h > 0 && (c.x < wr.x || c.y < wr.y || c.x >= wr.x + wr.w || c.y >= wr.y + wr.h)) return { ok: false, why: 'scrolled_away' };
  if (!onScreen(c)) return { ok: false, why: 'off_screen' };
  const h = await withTimeout(hit({ hwnd: win.hwnd, points: [[Math.round(c.x), Math.round(c.y)]] }), MOUSE.hitMs);
  const first = h?.ok && Array.isArray(h.hits) ? h.hits[0] : null;
  if (first && first.on === false && Number(first.pid) !== Number(selfPid)) return { ok: false, why: 'covered' };
  return { ok: true };
}

/**
 * Point at a control (point_at): glide there and rest on it for a few seconds, never clicking.
 * Resolves { shown: true, rect, where, via } or { shown: false, why, where? }.
 */
export async function pointAt({ win, node, scan }, deps = {}) {
  if (!mouseOn()) return { shown: false, why: 'off' };
  const cr = await controlRect({ win, node, scan }, { cdpMs: MOUSE.cdpPointMs, ...deps });
  if (!cr) return { shown: false, why: 'no_place' };
  const where = whereIn(cr.rect, win?.rect);
  if (!cr.inView) return { shown: false, why: 'scrolled_away', where, via: cr.via };
  const seen = await seenAt(win, cr.rect, deps);
  if (!seen.ok) return { shown: false, why: seen.why, where, via: cr.via };
  const c = center(cr.rect);
  const g = sink.glide({ x: c.x, y: c.y, holdMs: MOUSE.pointMs });
  if (!g?.shown) return { shown: false, why: g?.why || 'off', where, via: cr.via };
  return { shown: true, rect: cr.rect, where, via: cr.via, ms: g.ms };
}

/**
 * Before an act: glide to its control and press there. Waits about the lead time (never on anything
 * slow: finding the place has its own short limit), then lets the act go on while the press plays.
 * Resolves { shown, why?, ms } (ms: how long the act waited).
 */
export async function leadIn(p, deps = {}) {
  lastLeadResult = await leadOnce(p, deps);
  return lastLeadResult;
}
let lastLeadResult = null;
/** The latest lead-in's outcome ({ shown, why, ms }), for tests and diagnostics. */
export const lastLead = () => lastLeadResult;

async function leadOnce({ win, node, scan }, deps) {
  const t0 = Date.now();
  const lead = leadMs();
  if (!mouseOn() || !win || !node || lead <= 0) return { shown: false, why: 'off', ms: 0 };
  try {
    const found = await withTimeout(
      (async () => {
        const cr = await controlRect({ win, node, scan }, { cdpMs: MOUSE.cdpLeadMs, ...deps });
        if (!cr || !cr.inView) return { why: 'no_place' };
        const seen = await seenAt(win, cr.rect, deps);
        return seen.ok ? { cr } : { why: seen.why };
      })(),
      MOUSE.lookupMs,
    );
    if (!found?.cr) return { shown: false, why: found?.why || 'slow', ms: Date.now() - t0 };
    const c = center(found.cr.rect);
    const g = sink.glide({ x: c.x, y: c.y, ms: lead, holdMs: MOUSE.holdAfterActMs });
    if (!g?.shown) return { shown: false, why: g?.why || 'off', ms: Date.now() - t0 };
    await Promise.race([g.arrived, sleep(lead + 40)]);
    sink.press?.();
    return { shown: true, ms: Date.now() - t0, via: found.cr.via };
  } catch {
    return { shown: false, why: 'failed', ms: Date.now() - t0 };
  }
}

/** The setting went off: away with it. */
export function hideMouse() {
  sink?.hide?.();
}
