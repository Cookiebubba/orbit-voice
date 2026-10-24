// Typing into a Chromium / Electron app through its own DevTools protocol (opt-in).
//
// Web apps only take text that arrives as input events (see uia.ps1, "text that web apps really
// take"). Without the focus, the one way to make real input events is the app's DevTools protocol:
// Input.insertText types into the focused element of the page as if from the keyboard, and the page
// can be given that focus (DOM.focus) without the window ever becoming active.
//
// Only when the user turned it on (Settings -> Orbit anywhere -> "Type into apps through their
// debugging port"), and only for an app they started with a debugging port themselves
// (--remote-debugging-port=N on its command line): Orbit never adds one or restarts an app. Only on
// 127.0.0.1, only the page whose title is the window's, and only these calls: DOM.getDocument,
// Accessibility.queryAXTree (find the box by its accessible name, as UI Automation sees it) or
// DOM.querySelector on the attributes that name it (aria-label, placeholder, title, name),
// DOM.focus, Input.dispatchKeyEvent with an editing command (select all, or go to the end) and
// Input.insertText. Never Runtime.evaluate or anything that runs code in the page.

import { execFile } from 'node:child_process';
import WebSocket from 'ws';

export const CDP_LIMITS = Object.freeze({ connectMs: 2000, callMs: 3000, treeMs: 2500 });

/** The debugging port on an app's command line, or 0. (Windows: from the process list, read-only.) */
export function portFromCommandLine(cmd) {
  const m = String(cmd || '').match(/--remote-debugging-port[= ](\d{2,5})\b/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n < 65536 ? n : 0;
}

/** The command line of a process (Windows), or '' if it can't be read. */
export function commandLineOf(pid, { exec = execFile } = {}) {
  const id = Math.floor(Number(pid)) || 0;
  if (!id || process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${id}").CommandLine`], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? '' : String(out || '').trim()));
  });
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} timed out`)), ms))]);

/**
 * Type `text` into the box named `name` in the app window `win` ({ pid, title }) through its
 * DevTools port. `action` 'set_text' replaces what's there, 'type' adds at the end.
 * Resolves { ok: true, via: 'cdp' } or { ok: false, error: 'no_port' | 'no_page' | 'no_box' | 'failed', message }.
 */
export async function cdpType(win, { name, text, action = 'set_text', port = 0, fetchImpl = fetch, Ws = WebSocket, cmdline = commandLineOf } = {}) {
  const p = port || portFromCommandLine(await cmdline(win?.pid));
  if (!p) return { ok: false, error: 'no_port', message: 'That app wasn\x27t started with a debugging port.' };
  let pages;
  try {
    pages = await withTimeout(fetchImpl(`http://127.0.0.1:${p}/json/list`).then((r) => r.json()), CDP_LIMITS.connectMs, 'the debugging port');
  } catch (e) {
    return { ok: false, error: 'no_port', message: String(e?.message || e).slice(0, 120) };
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
  if (!page) return { ok: false, error: 'no_page', message: 'Couldn\x27t tell which page of that app is the window.' };
  const ws = new Ws(page.webSocketDebuggerUrl);
  try {
    await withTimeout(new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject))), CDP_LIMITS.connectMs, 'the page');
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
    const doc = await call('DOM.getDocument', { depth: 0 });
    let target = null; // { backendNodeId } or { nodeId }
    // By its accessible name, as UI Automation named it (a page in the background may never build
    // its accessibility tree: then by the attributes that name a box, in the page's own markup).
    try {
      for (const role of ['textbox', 'searchbox', 'combobox', undefined]) {
        const q = await call('Accessibility.queryAXTree', { nodeId: doc.root.nodeId, accessibleName: String(name || ''), ...(role ? { role } : {}) }, CDP_LIMITS.treeMs);
        const n = (q.nodes || []).find((x) => Number.isInteger(x.backendDOMNodeId));
        if (n) {
          target = { backendNodeId: n.backendDOMNodeId };
          break;
        }
      }
    } catch {}
    if (!target && name) {
      const q = JSON.stringify(String(name)); // a CSS string: quoted and escaped
      for (const sel of [`[aria-label=${q}]`, `[placeholder=${q}]`, `[title=${q}]`, `[name=${q}]`]) {
        const r = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
        if (r.nodeId) {
          target = { nodeId: r.nodeId };
          break;
        }
      }
    }
    if (!target) return { ok: false, error: 'no_box', message: 'Couldn\x27t find that box in the page.' };
    await call('DOM.focus', target);
    // Replace: select all of it first; add: the caret to the end. (Editing commands, not keys typed.)
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: action === 'type' ? 'End' : 'a', commands: [action === 'type' ? 'moveToEndOfDocument' : 'selectAll'] });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: action === 'type' ? 'End' : 'a' });
    if (text) await call('Input.insertText', { text: String(text) });
    return { ok: true, via: 'cdp' };
  } catch (e) {
    return { ok: false, error: 'failed', message: String(e?.message || e).slice(0, 160) };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}
