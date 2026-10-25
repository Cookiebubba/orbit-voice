// Acting in a Chromium / Electron app through its own DevTools protocol.
//
// Web apps only take text that arrives as input events (see uia.ps1, "text that web apps really
// take"). Without the focus, the one way to make real input events is the app's DevTools protocol:
// Input.insertText types into the focused element of the page as if from the keyboard, and the page
// can be given that focus (DOM.focus) without the window ever becoming active. Clicks go in as mouse
// events at the element's place in the page (never the user's cursor), and Page.captureScreenshot
// shows the page even behind other windows.
//
// Two ways to reach an app:
//   - "pipe" (the main one): an app the user approved, restarted under Orbit's pipe keeper (see
//     keeper.js). A private pipe, no network port.
//   - "port" (opt-in, Settings): an app the user started with --remote-debugging-port themselves.
//     Orbit never adds a port. Only on 127.0.0.1.
// Either way, only the page whose title is the window's, and only these calls: DOM.getDocument,
// Accessibility.queryAXTree / getFullAXTree, DOM.querySelector on the attributes that name a box
// (aria-label, placeholder, title, name), DOM.focus, DOM.getBoxModel, DOM.scrollIntoViewIfNeeded,
// Input.dispatchKeyEvent / dispatchMouseEvent / insertText, Page.captureScreenshot,
// Page.getLayoutMetrics, Browser.getWindowForTarget. Never Runtime.evaluate or anything that runs
// code in the page.

import { execFile } from 'node:child_process';
import WebSocket from 'ws';
import { getSetting } from '../config.js';
import { keeperForWindow, pageSession } from './keeper.js';
import { runHelperOnce } from '../platform/mac/helper.js';

export const CDP_LIMITS = Object.freeze({ connectMs: 2000, callMs: 3000, treeMs: 2500 });

/** The debugging port on an app's command line, or 0. (Windows: from the process list, read-only.) */
export function portFromCommandLine(cmd) {
  const m = String(cmd || '').match(/--remote-debugging-port[= ](\d{2,5})\b/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n < 65536 ? n : 0;
}

/** The command line of a process (Windows; macOS through Orbit's helper), or '' if it can't be read. */
export function commandLineOf(pid, { exec = execFile } = {}) {
  const id = Math.floor(Number(pid)) || 0;
  if (id && process.platform === 'darwin') return runHelperOnce(['proc', '--pid', String(id)], { timeoutMs: 5000 }).then((j) => (j?.ok ? [j.exe, ...(j.args || [])].join(' ') : ''));
  if (!id || process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${id}").CommandLine`], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? '' : String(out || '').trim()));
  });
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} timed out`)), ms))]);

/** A session over an app's debugging port (opt-in): { via: 'port', call, close } or an error result. */
async function portSession(win, { port = 0, fetchImpl = fetch, Ws = WebSocket, cmdline = commandLineOf } = {}) {
  const p = port || portFromCommandLine(await cmdline(win?.pid));
  if (!p) return { error: 'no_port', message: 'That app wasn\x27t started with a debugging port.' };
  let pages;
  try {
    pages = await withTimeout(fetchImpl(`http://127.0.0.1:${p}/json/list`).then((r) => r.json()), CDP_LIMITS.connectMs, 'the debugging port');
  } catch (e) {
    return { error: 'no_port', message: String(e?.message || e).slice(0, 120) };
  }
  const list = (Array.isArray(pages) ? pages : []).filter((t) => t?.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && /^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(t.webSocketDebuggerUrl));
  const title = String(win?.title || '').trim();
  // The page whose title is the window's: exactly (an app), or what it starts with (a browser adds
  // " - Google Chrome", its profile...); else the only page there is.
  const titled = (t) => String(t.title || '').trim();
  const page =
    list.find((t) => title && titled(t) === title) ||
    list.filter((t) => titled(t) && title.startsWith(`${titled(t)} `)).sort((a, b) => titled(b).length - titled(a).length)[0] ||
    (list.length === 1 ? list[0] : null);
  if (!page) return { error: 'no_page', message: 'Couldn\x27t tell which page of that app is the window.' };
  const ws = new Ws(page.webSocketDebuggerUrl);
  try {
    await withTimeout(new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject))), CDP_LIMITS.connectMs, 'the page');
  } catch (e) {
    try {
      ws.close();
    } catch {}
    return { error: 'failed', message: String(e?.message || e).slice(0, 160) };
  }
  let id = 0;
  const waiting = new Map();
  ws.on('message', (d) => {
    let m;
    try {
      m = JSON.parse(String(d));
    } catch {
      return;
    }
    if (m?.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
  });
  const call = (method, params = {}, ms = CDP_LIMITS.callMs) =>
    withTimeout(
      new Promise((resolve) => {
        const i = ++id;
        waiting.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
      ms,
      method,
    ).then((m) => {
      if (m.error) throw new Error(`${method}: ${String(m.error.message || 'failed').slice(0, 120)}`);
      return m.result || {};
    });
  return {
    via: 'port',
    call,
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

/**
 * A DevTools session on the page this window shows: through the app's keeper (an app under Orbit),
 * else (only with the setting on, or a port given) its own debugging port. Resolves
 * { via, call, close } or { error, message }.
 */
export async function openSession(win, opts = {}) {
  if (opts.session) return opts.session;
  if (!opts.port && keeperForWindow(win)) {
    try {
      const s = await pageSession(win);
      if (s) return s;
    } catch (e) {
      return { error: 'failed', message: String(e?.message || e).slice(0, 160) };
    }
  }
  if (!opts.port && !opts.cmdline && getSetting('anywhereCdp') !== true) return { error: 'no_port', message: 'That app isn\x27t under Orbit.' };
  return portSession(win, opts);
}

/** Runs `fn(call)` on the window's page, then closes the session. Errors become { ok: false, error, message }. */
async function onPage(win, opts, fn) {
  const s = await openSession(win, opts);
  if (s.error) return { ok: false, error: s.error, message: s.message };
  try {
    return await fn(s.call, s.via, s.browserCall);
  } catch (e) {
    return { ok: false, error: 'failed', message: String(e?.message || e).slice(0, 160) };
  } finally {
    if (!opts.session) s.close();
  }
}

/** The node in the page named `name` (its accessible name, else the attributes that name it), or null. */
async function findNode(call, name, roles = ['textbox', 'searchbox', 'combobox', undefined]) {
  const doc = await call('DOM.getDocument', { depth: 0 });
  // By its accessible name, as UI Automation named it (a page in the background may never build its
  // accessibility tree: then by the attributes that name it, in the page's own markup).
  try {
    for (const role of roles) {
      const q = await call('Accessibility.queryAXTree', { nodeId: doc.root.nodeId, accessibleName: String(name || ''), ...(role ? { role } : {}) }, CDP_LIMITS.treeMs);
      const n = (q.nodes || []).find((x) => Number.isInteger(x.backendDOMNodeId));
      if (n) return { backendNodeId: n.backendDOMNodeId };
    }
  } catch {}
  if (!name) return null;
  const q = JSON.stringify(String(name)); // a CSS string: quoted and escaped
  for (const sel of [`[aria-label=${q}]`, `[placeholder=${q}]`, `[title=${q}]`, `[name=${q}]`]) {
    const r = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
    if (r.nodeId) return { nodeId: r.nodeId };
  }
  return null;
}

/**
 * Type `text` into the box named `name` in the app window `win` ({ pid, title }). `action`
 * 'set_text' replaces what's there, 'type' adds at the end.
 * Resolves { ok: true, via } or { ok: false, error: 'no_port' | 'no_page' | 'no_box' | 'failed', message }.
 */
export async function cdpType(win, { name, text, action = 'set_text', ...opts } = {}) {
  return onPage(win, opts, async (call, via) => {
    const target = await findNode(call, name);
    if (!target) return { ok: false, error: 'no_box', message: 'Couldn\x27t find that box in the page.' };
    await call('DOM.focus', target);
    // Replace: select all of it first; add: the caret to the end. (Editing commands, not keys typed.)
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: action === 'type' ? 'End' : 'a', commands: [action === 'type' ? 'moveToEndOfDocument' : 'selectAll'] });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: action === 'type' ? 'End' : 'a' });
    if (text) await call('Input.insertText', { text: String(text) });
    return { ok: true, via: via === 'pipe' ? 'pipe' : 'cdp' };
  });
}

/** Press Enter in the box named `name` (sends in a chat box: the caller gates it as outward). */
export async function cdpEnter(win, { name, ...opts } = {}) {
  return onPage(win, opts, async (call, via) => {
    const target = await findNode(call, name);
    if (!target) return { ok: false, error: 'no_box', message: 'Couldn\x27t find that box in the page.' };
    await call('DOM.focus', target);
    for (const type of ['rawKeyDown', 'char', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'char' ? { text: '\r' } : {}) });
    return { ok: true, via };
  });
}

/** Where an element is in the page (CSS pixels): { x, y, w, h } of its box, scrolled into view (unless `scroll` is false). */
async function boxOf(call, target, { scroll = true } = {}) {
  if (scroll) {
    try {
      await call('DOM.scrollIntoViewIfNeeded', target);
    } catch {}
  }
  const { model } = await call('DOM.getBoxModel', target);
  const q = model?.border || model?.content;
  if (!Array.isArray(q) || q.length < 8) return null;
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Click the element named `name` with mouse events at its middle in the page (never the user's cursor). */
export async function cdpClick(win, { name, role, ...opts } = {}) {
  return onPage(win, opts, async (call, via) => {
    const target = await findNode(call, name, role ? [role, undefined] : ['button', 'link', 'menuitem', 'tab', 'checkbox', 'option', undefined]);
    if (!target) return { ok: false, error: 'no_box', message: 'Couldn\x27t find that in the page.' };
    const b = await boxOf(call, target);
    if (!b) return { ok: false, error: 'failed', message: 'That isn\x27t on the page right now.' };
    const x = b.x + b.w / 2;
    const y = b.y + b.h / 2;
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true, via, box: b };
  });
}

/** A picture of the page, even behind other windows: { ok, png (base64), via }. */
export async function cdpScreenshot(win, { maxWidth = 1600, ...opts } = {}) {
  return onPage(win, opts, async (call, via) => {
    const m = await call('Page.getLayoutMetrics').catch(() => ({}));
    const w = Number(m?.cssVisualViewport?.clientWidth || m?.layoutViewport?.clientWidth) || 0;
    const scale = w > maxWidth ? maxWidth / w : 1;
    const shot = await call('Page.captureScreenshot', { format: 'png', ...(scale < 1 ? { clip: { x: 0, y: 0, width: w, height: Number(m?.cssVisualViewport?.clientHeight || m?.layoutViewport?.clientHeight) || 0, scale } } : {}) }, 8000);
    if (!shot?.data) return { ok: false, error: 'failed', message: 'No picture came back.' };
    return { ok: true, png: shot.data, via };
  });
}

/**
 * Where an element is on the screen ({ x, y, w, h } in screen pixels), for the Orbit mouse: the
 * element's place in the page plus where the page sits on screen. `contentRect` (the window's page
 * area on screen, from UI Automation) is the most exact; without it, the window's bounds.
 * `scroll: false` leaves the page as it is (pointing is read-only): an element scrolled out of view
 * then comes back with `inView: false`.
 */
export async function cdpElementRect(win, { name, role, contentRect = null, scroll = true, ...opts } = {}) {
  return onPage(win, opts, async (call, _via, browserCall) => {
    const target = await findNode(call, name, role ? [role, undefined] : [undefined]);
    if (!target) return { ok: false, error: 'no_box' };
    const b = await boxOf(call, target, { scroll });
    if (!b) return { ok: false, error: 'failed' };
    const m = await call('Page.getLayoutMetrics').catch(() => ({}));
    const cssW = Number(m?.cssLayoutViewport?.clientWidth || m?.layoutViewport?.clientWidth) || 0;
    // Where the page sits: given, else the window's rect Orbit already knows, else asked of the app.
    let origin = contentRect || (win?.rect?.w > 0 ? win.rect : null);
    if (!origin && browserCall) {
      const w = await browserCall('Browser.getWindowForTarget').catch(() => null);
      origin = w?.bounds ? { x: w.bounds.left, y: w.bounds.top, w: w.bounds.width, h: w.bounds.height } : null;
    }
    if (!origin) return { ok: false, error: 'failed' };
    const cssH = Number(m?.cssLayoutViewport?.clientHeight || m?.layoutViewport?.clientHeight) || 0;
    const zoom = cssW && origin.w ? origin.w / cssW : 1; // CSS pixels to screen pixels (display scaling, page zoom)
    // From the window's outer bounds, the page sits at the bottom (any title bar is above it).
    const top = contentRect ? 0 : Math.max(0, origin.h - cssH * zoom);
    const inView = !cssW || !cssH || (b.x + b.w / 2 >= 0 && b.y + b.h / 2 >= 0 && b.x + b.w / 2 <= cssW && b.y + b.h / 2 <= cssH);
    return { ok: true, inView, rect: { x: Math.round(origin.x + b.x * zoom), y: Math.round(origin.y + top + b.y * zoom), w: Math.round(b.w * zoom), h: Math.round(b.h * zoom) } };
  });
}

/** Is this window's app reachable through DevTools right now (under Orbit, or a port with the setting on)? */
export const cdpReachable = (win) => !!keeperForWindow(win);
