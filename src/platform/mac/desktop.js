// The Claude desktop app's window on macOS: what src/desktop.ps1 does on Windows, through the macOS
// accessibility API (the helper's "ax" mode: a snapshot of a window's tree, then one action on one
// element). Claude is an Electron app, so its page is the same on both systems and Chromium shows it
// alike (UI Automation on Windows, AX on macOS); the helper reports it with UI Automation's names
// (Button, Edit, Document, Group, Text...), so the logic below follows desktop.ps1 step by step, and
// answers with the same JSON. It never moves the mouse, presses keys or touches the clipboard; the
// one change of focus is the one you ask for (switching to a session in another Claude window brings
// that window to the front).
//
// run(mode, args) takes desktop.js's arguments as desktop.ps1 does (['-TitleB64', '...', '-ExpectNew',
// '-FrontHwnd', '123', ...]) and resolves one result object.
//
// Where the Mac's tree differs from Windows' (seen on the live app, read-only, 2026-10):
//  - Chromium shows every div as an AXGroup (UI Automation leaves unnamed ones out of its control
//    view), so "the parent" of an element becomes its nearest named group, and a session row's
//    "More options for <title>" button sits one level deeper than its session button.
//  - Headings are text with a text child carrying the same words: only the child is read.
//  - Scrolling the conversation scrolls a message into view (there is no scroll pattern).

import crypto from 'node:crypto';

export const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop';
const SWITCHES = new Set(['Rects', 'ExpectNew', 'DryRun', 'Fill', 'Filled', 'Clear']);
const decode = (b64) => Buffer.from(String(b64 || ''), 'base64').toString('utf8');

/** desktop.ps1-style arguments as an object: { TitleB64: '..', ExpectNew: true, FrontHwnd: '123' }. */
export function parseArgs(args = []) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith('-')) continue;
    const k = a.slice(1);
    if (SWITCHES.has(k)) o[k] = true;
    else {
      o[k] = args[i + 1] === undefined ? '' : String(args[i + 1]);
      i++;
    }
  }
  return o;
}

// ---- a window's tree (the helper's scan) ----

/** The scan's nodes with parents, children and subtree ranges (the scan is depth-first, parents first). */
export class Tree {
  constructor(nodes = []) {
    this.nodes = nodes;
    this.kids = nodes.map(() => []);
    for (const n of nodes) if (n.p >= 0 && this.kids[n.p]) this.kids[n.p].push(n);
    this.end = nodes.map((n) => n.i);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.p >= 0 && this.end[n.p] < this.end[i]) this.end[n.p] = this.end[i];
    }
  }
  get root() {
    return this.nodes[0] || null;
  }
  parent(n) {
    return n && n.p >= 0 ? this.nodes[n.p] : null;
  }
  children(n) {
    return n ? this.kids[n.i] : [];
  }
  /** Every node below `n` (not itself), in tree order. */
  descendants(n) {
    return n ? this.nodes.slice(n.i + 1, this.end[n.i] + 1) : [];
  }
  /** Is `n` inside `a`'s subtree (or `a` itself)? */
  within(n, a) {
    return !!(n && a) && n.i >= a.i && n.i <= this.end[a.i];
  }
  /** Ancestors, nearest first (up to `max`). */
  ancestors(n, max = 80) {
    const out = [];
    for (let p = this.parent(n); p && out.length < max; p = this.parent(p)) out.push(p);
    return out;
  }
  /** Steps below the window. */
  depth(n) {
    return this.ancestors(n).length;
  }
}

const nameOf = (n) => String(n?.n ?? '');
const hasClass = (n, cls) => ` ${String(n?.c || '')} `.includes(` ${cls} `);
const isButton = (n) => n?.t === 'Button';
const pressable = (n) => /[ITS]/.test(String(n?.pat || ''));
const enabled = (n) => n?.en !== 0;
const isToggle = (n) => /T/.test(String(n?.pat || '')) || n?.tog !== undefined;
const pressed = (n) => Number(n?.tog) === 1;
const rectOf = (n) => (Array.isArray(n?.r) && n.r[2] > 0 && n.r[3] > 0 ? { x: n.r[0], y: n.r[1], w: n.r[2], h: n.r[3] } : null);
const area = (n) => (Array.isArray(n?.r) ? Math.max(0, n.r[2]) * Math.max(0, n.r[3]) : 0);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};
const key16 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

// ---- the names desktop.ps1 matches (kept identical) ----
const APOS = '’';
const STOP_NAMES = ['Stop', 'Stop response', 'Stop generating', 'Stop Claude', 'Interrupt'];
const ALLOW_ONCE = ['Allow once', 'Allow', 'Yes', 'Approve', 'Accept', 'Run', 'Continue'];
const ALLOW_SESSION = ['Allow for this session', 'Allow for this chat', 'Allow for this task', 'Yes, for this session', 'Allow all for this website'];
const ALLOW_ALWAYS = ['Always allow', 'Allow always', 'Always allow for this website', "Yes, and don't ask again", `Yes, and don${APOS}t ask again`, 'Allow for all scheduled runs'];
const DENY = ['Deny', "Don't allow", `Don${APOS}t allow`, 'Reject', 'Decline', 'No', 'Keep planning', 'Stay in background'];
const STRONG = ['Allow once', 'Allow', 'Always allow', 'Allow always', 'Allow for this session', 'Approve', 'Deny', "Don't allow", `Don${APOS}t allow`, 'Reject'];
const QUESTION_ACTIONS = ['Submit', 'Next', 'Skip'];
const COMMAND_REGIONS = ['The command Claude wants to run', `Claude${APOS}s description and the command Claude wants to run`, "Claude's description and the command Claude wants to run", 'What Claude is asking to do'];
const PERM_LIKE = /^(ask( before edits| permissions)?|accept edits|edit automatically|auto( mode|-accept edits)?|plan mode|bypass permissions|default)$/i;
const PANELS = { terminal: 'Terminal', changes: 'Changes', browser: 'Browser', files: 'Files', rail: 'Hide session rail' };

/** How a button answers a permission card: allow_once | allow_session | allow_always | deny | null. */
export function answerKind(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (ALLOW_ALWAYS.includes(n) || /^Always allow/i.test(n) || /^Accept and /i.test(n)) return 'allow_always';
  if (ALLOW_SESSION.includes(n) || /^Allow for /i.test(n)) return 'allow_session';
  if (ALLOW_ONCE.includes(n)) return 'allow_once';
  if (DENY.includes(n) || /^Deny/i.test(n) || /^No, /i.test(n)) return 'deny';
  return null;
}

/** The same text whatever the line endings, spacing or quote marks (as desktop.ps1 compares). */
export const normText = (t) =>
  String(t ?? '')
    .replace(/\r/g, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[   ]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
const same = (a, b) => normText(a) === normText(b);

export function createMacDesktop({ request, onlyPid = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), bundle = CLAUDE_BUNDLE_ID } = {}) {
  if (typeof request !== 'function') throw new Error('createMacDesktop needs request(op, args)');

  // ---- windows and their pages ----
  async function claudeWindows() {
    const r = await request('windows', onlyPid ? { pid: onlyPid } : { bundle });
    if (!r?.ok) return { error: r };
    const wins = (r.windows || []).filter((w) => (w.sr === 'AXStandardWindow' || !w.sr) && w.w >= 200 && w.h >= 150 && w.title);
    return { running: !!r.running, wins: wins.map((w, z) => ({ hwnd: w.hwnd, name: w.title, min: !!w.min || w.onscreen === false, z, focused: !!w.focused, rect: { x: w.x, y: w.y, w: w.w, h: w.h } })) };
  }

  async function scan(w, { full = false } = {}) {
    const r = await request('scan', { hwnd: w.hwnd, values: true, maxNodes: 20000, ...(full ? {} : { skip: ['Chat messages'] }) });
    if (!r?.ok) {
      w.tree = null;
      return false;
    }
    w.tree = new Tree(r.nodes || []);
    w.full = full;
    return true;
  }

  /** Claude's own page in a window (see desktop.ps1 Find-AppDocument): { doc, kind } or null. */
  function findAppDocument(w) {
    const T = w.tree;
    if (!T) return null;
    const docs = T.nodes.filter((n) => n.t === 'Document');
    let best = null;
    let bestScore = -1;
    const pop = [];
    for (const d of docs) {
      const named = nameOf(d) === 'Claude' || / - Claude Code$/.test(nameOf(d));
      const hasSidebar = T.descendants(d).some((x) => x.t === 'Group' && nameOf(x) === 'Sidebar');
      if (hasSidebar || named) {
        const score = (hasSidebar ? 1e12 : 0) + area(d);
        if (score > bestScore) {
          best = d;
          bestScore = score;
        }
      } else if (w.name && w.name !== 'Claude' && nameOf(d) === w.name) pop.push(d);
    }
    if (best) return { doc: best, kind: 'main' };
    if (!pop.length) return null;
    const depths = pop.map((d) => T.depth(d));
    const top = Math.min(...depths);
    const at = pop.filter((_, i) => depths[i] === top);
    if (at.length !== 1) return null; // two pages that look alike: don't guess
    const doc = at[0];
    const inside = (b) => ownDoc(T, b) === doc;
    const header = T.descendants(doc).some((b) => isButton(b) && nameOf(b) === `${w.name}, rename session` && inside(b));
    const back = T.descendants(doc).some((b) => isButton(b) && nameOf(b) === 'Open in main window' && inside(b));
    if (!header || !back) return null;
    return { doc, kind: 'popout' };
  }

  /** The nearest document an element belongs to. */
  function ownDoc(T, n) {
    if (n?.t === 'Document') return n;
    return T.ancestors(n).find((a) => a.t === 'Document') || null;
  }

  /** A window as desktop.ps1's Use-Window leaves it: page found, title read. false if no page. */
  async function useWindow(w, { full = false, rescan = false } = {}) {
    if (!w.tree || rescan || (full && !w.full)) {
      if (!(await scan(w, { full }))) return false;
      w.page = undefined;
    }
    if (w.page === undefined) w.page = findAppDocument(w);
    if (!w.page) return false;
    w.title = sessionTitle(w);
    w.kind = w.page.kind;
    w.sidebar = w.page.kind === 'main' && w.tree.descendants(w.page.doc).some((x) => x.t === 'Group' && nameOf(x) === 'Sidebar');
    return true;
  }

  function sessionTitle(w) {
    const n = nameOf(w.page?.doc);
    if (n.endsWith(' - Claude Code') && n.length > ' - Claude Code'.length) return n.slice(0, -' - Claude Code'.length);
    if (w.page?.kind === 'popout' && n && n !== 'Claude') return n;
    return null;
  }

  const inApp = (w, n) => !!w.page && ownDoc(w.tree, n) === w.page.doc;
  const appNodes = (w) => (w.page ? w.tree.descendants(w.page.doc) : []);

  async function usableWindows() {
    const cw = await claudeWindows();
    if (cw.error) return cw;
    const usable = [];
    for (const w of cw.wins) {
      try {
        if (await useWindow(w)) usable.push(w);
      } catch {}
    }
    return { all: cw.wins, wins: usable, running: cw.running };
  }

  function selectFront(wins, frontHint) {
    const hint = Number(frontHint) || 0;
    if (hint) {
      const w = wins.find((x) => x.hwnd === hint && !x.min);
      if (w) return w;
    }
    return wins.find((x) => !x.min) || wins[0] || null;
  }

  const windowList = (wins, front) => wins.slice(0, 12).map((w) => ({ id: w.hwnd, title: w.title, kind: w.kind, front: w === front, minimized: w.min }));

  async function showWindow(w) {
    const r = await request('raise', { hwnd: w.hwnd });
    return !!(r?.ok && r.switched);
  }

  // ---- the page's parts ----

  function promptBox(w) {
    const boxes = appNodes(w).filter((n) => n.t === 'Edit' && nameOf(n) === 'Prompt');
    if (!boxes.length) return null;
    return boxes.find((b) => b.foc) || boxes[0];
  }

  function boxText(box) {
    const v = String(box?.v ?? '').replace(/\s+$/, '');
    if (v.trim() === '/') return '';
    return v;
  }

  /** Claude's Send (or Stop) button on the prompt box's row (see desktop.ps1 Get-SendButton). */
  function sendButton(w, box, { anyState = false, names = ['Send'] } = {}) {
    const b0 = rectOf(box);
    if (!b0) return null;
    const right = b0.x + b0.w;
    const bottom = b0.y + b0.h;
    let best = null;
    let bestDist = Infinity;
    for (const b of appNodes(w)) {
      if (!isButton(b) || !names.includes(nameOf(b)) || (!anyState && !enabled(b))) continue;
      const r = rectOf(b);
      if (!r) continue;
      const cy = r.y + r.h / 2;
      if (cy < b0.y - 40 || cy > bottom + 80) continue;
      const dx = Math.abs(r.x - right);
      if (r.x < b0.x || dx > 200) continue;
      const d = Math.abs(cy - bottom) + dx;
      if (d < bestDist) {
        best = b;
        bestDist = d;
      }
    }
    return best;
  }

  const inSidebarTree = (w, n) => w.tree.ancestors(n).some((a) => a.t === 'Group' && nameOf(a) === 'Sidebar');
  /**
   * A session row's own button: named after a session the sidebar has a "More options for <title>"
   * button for (by name, not by where it sits: Chromium on a Mac may leave the row's divs out).
   */
  function inSessionRow(w, n) {
    const name = nameOf(n);
    if (!name) return false;
    for (const b of appNodes(w)) {
      const m = nameOf(b);
      if (!isButton(b) || !m.startsWith('More options for ')) continue;
      const t = m.slice('More options for '.length);
      if (t && (name === t || name.startsWith(`${t} `))) return true;
    }
    return false;
  }
  /** One of the sidebar's own buttons (not a session row's): see desktop.ps1 Test-SidebarButton. */
  const sidebarButton = (w, b) => inApp(w, b) && inSidebarTree(w, b) && !inSessionRow(w, b) && !nameOf(b).startsWith('More options for ');

  /** Sessions in the sidebar: [{ title, button, label }] in sidebar order. */
  function sidebarSessions(w) {
    const out = [];
    const seen = new Set();
    for (const b of appNodes(w)) {
      const n = nameOf(b);
      if (!isButton(b) || !n.startsWith('More options for ') || !inSidebarTree(w, b)) continue;
      const t = n.slice('More options for '.length);
      if (!t || seen.has(t)) continue;
      let match = null;
      for (const up of w.tree.ancestors(b, 3)) {
        for (const s of w.tree.children(up)) {
          const sn = nameOf(s);
          if (isButton(s) && sn && (sn === t || sn.startsWith(`${t} `)) && !sn.startsWith('More options') && pressable(s)) {
            match = s;
            break;
          }
        }
        if (match) break;
      }
      if (match) {
        seen.add(t);
        out.push({ title: t, button: match, label: nameOf(match) });
      }
    }
    return out;
  }

  function sidebarButtonNamed(w, name) {
    return appNodes(w).find((b) => isButton(b) && nameOf(b) === name && enabled(b) && sidebarButton(w, b) && pressable(b)) || null;
  }

  function newInFolderButtons(w) {
    const out = [];
    for (const b of appNodes(w)) {
      const n = nameOf(b);
      if (!isButton(b) || !n.startsWith('New session in ')) continue;
      const rest = n.slice('New session in '.length);
      const i = rest.lastIndexOf(', added to ');
      const folder = i >= 0 ? rest.slice(0, i) : rest;
      const group = i >= 0 ? rest.slice(i + ', added to '.length) : '';
      if (folder && sidebarButton(w, b) && pressable(b)) out.push({ folder, group, button: b });
    }
    return out;
  }

  /** A new session that hasn't started yet: { folder } or null (see desktop.ps1 Get-NewSessionPage). */
  function newSessionPage(w, title) {
    if (title !== null && title !== undefined) return null;
    if (nameOf(w.page?.doc) !== 'Claude') return null;
    if (!promptBox(w)) return null;
    let heading = null;
    for (const t of appNodes(w)) {
      if (t.t !== 'Text' || t.role === 'AXHeading' || nameOf(t) !== 'New session' || t.off) continue;
      const inside = w.tree.ancestors(t, 40).some((p) => p.t !== 'Document' && ['Sidebar', 'Chat messages'].includes(nameOf(p)));
      if (!inside) {
        heading = t;
        break;
      }
    }
    if (!heading) return null;
    for (const b of appNodes(w)) {
      const n = nameOf(b);
      if (isButton(b) && n.startsWith('Folder: ') && n.length > 'Folder: '.length) return { folder: n.slice('Folder: '.length).trim() };
    }
    return { folder: null };
  }

  // ---- cards (what Claude is waiting on the user for) ----

  /** Text inside an element, in order, leaving out button labels (see desktop.ps1 Get-Texts). */
  function texts(w, el, max = 12) {
    const sub = w.tree.descendants(el);
    const skip = new Set(sub.filter(isButton).map(nameOf));
    const out = [];
    for (const t of sub) {
      if (t.t !== 'Text' || t.role === 'AXHeading') continue;
      const n = clip(nameOf(t), 400);
      if (n && !skip.has(n)) out.push(n);
      if (out.length >= max) break;
    }
    return out;
  }
  const buttonsIn = (w, el) => w.tree.descendants(el).filter(isButton);
  const answerButtons = (w, el) => buttonsIn(w, el).filter((b) => answerKind(nameOf(b)));
  /** The nearest named or classed container above `n` (Chromium's many plain divs skipped). */
  // (Chromium on a Mac may leave plain divs out of the tree, or show many: every level counts.)
  const containers = (w, n, max) => beforeDoc(w, n).slice(0, max);
  const beforeDoc = (w, n) => {
    const out = [];
    for (const a of w.tree.ancestors(n, 60)) {
      if (a.t === 'Document') break;
      out.push(a);
    }
    return out;
  };

  function findCards(w) {
    const cards = [];
    for (const b of appNodes(w)) {
      if (!isButton(b)) continue;
      const name = nameOf(b);
      const mine = answerKind(name);
      if (!(mine || QUESTION_ACTIONS.includes(name) || hasClass(b, 'epitaxy-answer-option'))) continue;
      let card = beforeDoc(w, b).slice(0, 30).find((p) => hasClass(p, 'epitaxy-approval-card')) || null;
      if (!card && STRONG.includes(name)) {
        // By structure: the nearest container holding this button and one that answers the other way.
        for (const p of containers(w, b, 4)) {
          const other = buttonsIn(w, p).some((o) => STRONG.includes(nameOf(o)) && (answerKind(nameOf(o)) === 'deny') !== (mine === 'deny'));
          if (other) {
            card = p;
            break;
          }
        }
        // That is the row of buttons; the card is the nearest container above it with text of its own.
        if (card && !texts(w, card, 1).length) {
          const count = answerButtons(w, card).length;
          for (const up of containers(w, card, 3)) {
            if (answerButtons(w, up).length !== count) break;
            if (texts(w, up, 1).length) {
              card = up;
              break;
            }
          }
        }
      }
      if (!card && QUESTION_ACTIONS.includes(name)) {
        for (const p of containers(w, b, 5)) {
          const toggles = buttonsIn(w, p).filter((x) => nameOf(x) !== 'Other' && isToggle(x));
          if (toggles.length >= 2) {
            card = p;
            break;
          }
        }
      }
      if (!card || sidebarButton(w, b) || !inApp(w, card)) continue;
      if (!cards.includes(card)) cards.push(card);
    }
    return cards.sort((a, b) => a.i - b.i);
  }

  function readCard(w, card) {
    const buttons = buttonsIn(w, card);
    let isQ = hasClass(card, 'epitaxy-question-card');
    let opts = buttons.filter((b) => hasClass(b, 'epitaxy-answer-option'));
    if (!opts.length) {
      const names = buttons.map(nameOf);
      const toggles = buttons.filter((b) => nameOf(b) !== 'Other' && isToggle(b));
      if (toggles.length >= 2 && (names.includes('Skip') || names.includes('Submit') || names.includes('Next'))) {
        isQ = true;
        opts = toggles;
      }
    }
    if (isQ || opts.length) {
      let q = clip(nameOf(card), 400);
      const all = texts(w, card, 40);
      if (!q && all.length) q = all[0];
      const page = all.find((t) => /^\d+ of \d+$/.test(t)) || '';
      const choices = opts.map((o, k) => {
        const t = texts(w, o, 3);
        return { n: k + 1, label: t.length ? t[0] : clip(nameOf(o), 200), description: t.length > 1 ? t[1] : '', selected: pressed(o) };
      });
      const radio = w.tree.descendants(card).some((x) => hasClass(x, 'epitaxy-radio-mark'));
      const acts = buttons.filter((b) => QUESTION_ACTIONS.includes(nameOf(b))).map(nameOf);
      const sig = `question|${q}|${page}|${choices.map((c) => c.label).join('|')}`;
      const multi = choices.length > 0 && !radio && opts.some((o) => hasClass(o, 'epitaxy-answer-option'));
      return { kind: 'question', question: q, choices, multiSelect: multi, page: page || null, canSkip: acts.includes('Skip'), key: key16(sig) };
    }
    const options = [];
    for (const b of buttons) {
      const k = answerKind(nameOf(b));
      if (k && enabled(b)) options.push({ id: k, label: clip(nameOf(b), 80) });
    }
    let detail = '';
    for (const g of w.tree.descendants(card)) {
      if (g.t === 'Group' && COMMAND_REGIONS.includes(nameOf(g))) {
        detail = clip(texts(w, g, 20).join(' '), 600);
        break;
      }
    }
    const txt = texts(w, card, 20).filter((t) => t && !(detail && detail.includes(t)));
    const title = clip(txt.slice(0, 3).join(' '), 300);
    if (!detail && txt.length > 3) detail = clip(txt.slice(3).join(' '), 600);
    const sig = `permission|${title}|${detail}|${options.map((o) => o.label).join('|')}`;
    return { kind: 'permission', title, detail, options, key: key16(sig) };
  }

  function pending(w) {
    const cards = findCards(w);
    if (!cards.length) return null;
    const c = cards[cards.length - 1];
    return { card: c, info: readCard(w, c), count: cards.length };
  }
  function cardByKey(w, key) {
    for (const c of findCards(w)) {
      const info = readCard(w, c);
      if (info.key === key) return { card: c, info };
    }
    return null;
  }

  // ---- acting ----
  async function act(w, n, action, value) {
    const r = await request('act', { hwnd: w.hwnd, i: n.i, rid: n.rid, t: n.t, action, ...(value !== undefined ? { value } : {}) });
    return r?.ok ? r : null;
  }
  const press = async (w, n) => !!(await act(w, n, 'press'));
  async function setBox(w, box, text) {
    // Claude's editor is ProseMirror: the value goes in as Chromium sets a rich box's text (as UI
    // Automation's SetValue does on Windows), and ProseMirror reads the change from the page.
    const r = await request('act', { hwnd: w.hwnd, i: box.i, rid: box.rid, t: box.t, action: 'set_text', value: text, method: 'value' });
    return r?.ok ? r : null;
  }
  /** Look at the window again (its page and title re-found). */
  async function refresh(w, opts = {}) {
    return useWindow(w, { ...opts, rescan: true });
  }

  // ---- the modes ----
  const out = (o) => o;

  async function run(mode, rawArgs = []) {
    const a = parseArgs(rawArgs);
    const all = await usableWindows();
    if (all.error) {
      const e = all.error;
      if (e?.error === 'access_denied') return out({ ok: false, error: 'accessibility_denied', message: 'Orbit needs Accessibility permission to use the Claude app: System Settings > Privacy & Security > Accessibility, turn on Orbit.' });
      return out({ ok: false, error: 'script_failed', message: String(e?.message || e?.error || 'The macOS helper did not answer.').slice(0, 300) });
    }
    if (!all.running || !all.all.length) return out({ ok: false, error: 'claude_window_not_found', message: 'The Claude desktop app is not open (or its window is closed).' });
    const wins = all.wins;
    if (!wins.length) return out({ ok: false, error: 'claude_page_not_found', message: "The Claude window is open, but its page isn't showing (still loading?)." });
    const front = selectFront(wins, a.FrontHwnd);
    let title = front.title;
    const windows = windowList(wins, front);

    if (mode === 'info') {
      const w = front;
      const box = promptBox(w);
      const page = newSessionPage(w, title);
      const boxRect = box ? rectOf(box) : null;
      const winRect = rectOf(w.page.doc);
      let sendRect = null;
      if (a.Rects && box) {
        const sb = sendButton(w, box, { anyState: true });
        if (sb) sendRect = rectOf(sb);
      }
      const working = box ? !!sendButton(w, box, { names: STOP_NAMES }) : false;
      return out({ ok: true, sessionTitle: title, newSession: !!page, folder: page ? page.folder : null, promptBoxFound: !!box, promptText: box ? boxText(box) : null, windowId: w.hwnd, windows, promptBoxRect: boxRect, windowRect: winRect, sendButtonRect: sendRect, claudeWorking: working });
    }

    if (mode === 'list') {
      const openIn = new Map();
      for (const w of wins) if (w.title && !openIn.has(w.title)) openIn.set(w.title, w.hwnd);
      const rows = [];
      const seen = new Set();
      for (const w of [front, ...wins.filter((x) => x !== front)]) {
        if (!w.sidebar) continue;
        for (const s of sidebarSessions(w)) {
          if (seen.has(s.title)) continue;
          seen.add(s.title);
          const inWin = openIn.get(s.title);
          rows.push({ title: s.title, label: s.label, open: !!inWin, front: s.title === title, window: inWin || w.hwnd });
        }
      }
      for (const w of wins) {
        if (w.title && !seen.has(w.title)) {
          seen.add(w.title);
          rows.push({ title: w.title, label: w.title, open: true, front: w === front, window: w.hwnd });
        }
      }
      return out({ ok: true, sessionTitle: title, sessions: rows, windowId: front.hwnd, windows });
    }

    if (mode === 'switch') {
      const want = decode(a.TitleB64).trim();
      if (!want) return out({ ok: false, error: 'empty_title' });
      if (title === want) return out({ ok: true, switched: false, sessionTitle: title, windowId: front.hwnd, message: 'That session is already open.' });
      let shown = wins.find((w) => w.title === want) || null;
      let hit = null;
      let hitWin = null;
      if (!shown) {
        const bars = [front, ...wins.filter((x) => x !== front)].filter((w) => w.sidebar);
        const allRows = [];
        for (const w of bars) for (const s of sidebarSessions(w)) allRows.push({ s, w });
        let pick = allRows.find((x) => x.s.title === want);
        if (!pick) pick = allRows.find((x) => x.s.title.toLowerCase().includes(want.toLowerCase()));
        if (!pick) {
          shown = wins.find((w) => w.title && w.title.toLowerCase().includes(want.toLowerCase())) || null;
          if (!shown) return out({ ok: false, error: 'session_not_in_sidebar', message: "Couldn't find that session in Claude's sidebar. It may be archived or scrolled out of the list.", sessionTitle: title });
        } else {
          hit = pick.s;
          hitWin = pick.w;
          if (hit.title === title) return out({ ok: true, switched: false, sessionTitle: title, windowId: front.hwnd, message: 'That session is already open.' });
          const other = wins.find((w) => w.title === hit.title);
          if (other) {
            shown = other;
            hit = null;
          }
        }
      }
      if (shown) {
        if (shown === front || (await showWindow(shown))) return out({ ok: true, switched: true, broughtForward: true, sessionTitle: shown.title, windowId: shown.hwnd });
        return out({ ok: false, error: 'window_not_raised', message: "That session is open in another Claude window, but macOS didn't let Orbit bring it to the front. Click that window to use it.", sessionTitle: title });
      }
      if (!(await press(hitWin, hit.button))) return out({ ok: false, error: 'switch_not_confirmed', message: "Couldn't press that session in the sidebar.", sessionTitle: title });
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        if (!(await refresh(hitWin))) continue;
        const now = hitWin.title;
        if (now === hit.title) {
          if (hitWin !== front && !(await showWindow(hitWin))) {
            return out({ ok: false, error: 'window_not_raised', message: "Opened the session in another Claude window, but macOS didn't let Orbit bring that window to the front. Click it to use it.", sessionTitle: title });
          }
          return out({ ok: true, switched: true, sessionTitle: now, windowId: hitWin.hwnd });
        }
      }
      return out({ ok: false, error: 'switch_not_confirmed', message: "Clicked the session in the sidebar, but the window didn't confirm the switch.", sessionTitle: hitWin.title ?? null });
    }

    if (mode === 'new') {
      const target = front.sidebar ? front : wins.find((w) => w.sidebar);
      if (!target) return out({ ok: false, error: 'new_button_not_found', message: "Couldn't find Claude's New session button. Is the sidebar hidden?", sessionTitle: title });
      const ttitle = target.title;
      let box = promptBox(target);
      if (box && boxText(box)) return out({ ok: false, error: 'prompt_box_not_empty', message: "The prompt box has text typed in it, so Orbit stayed in this session (so the draft isn't lost).", sessionTitle: ttitle });
      const want = a.ProjectB64 ? decode(a.ProjectB64).trim() : '';
      let button = null;
      if (want) {
        const choices = newInFolderButtons(target);
        const names = [...new Set(choices.map((c) => c.folder))].slice(0, 15);
        const lw = want.toLowerCase();
        let hits = choices.filter((c) => c.folder.toLowerCase() === lw || c.group.toLowerCase() === lw);
        if (!hits.length) hits = choices.filter((c) => c.folder.toLowerCase().includes(lw) || c.group.toLowerCase().includes(lw));
        if (!hits.length) return out({ ok: false, error: 'project_not_in_sidebar', message: "Claude's sidebar has no project folder by that name.", projects: names, sessionTitle: ttitle });
        const folders = [...new Set(hits.map((h) => h.folder))];
        if (folders.length > 1) return out({ ok: false, error: 'project_ambiguous', message: 'More than one project folder matches that name.', projects: folders.slice(0, 15), sessionTitle: ttitle });
        button = hits[0].button;
      } else {
        const page = newSessionPage(target, ttitle);
        if (page) {
          if (target !== front && !(await showWindow(target))) return out({ ok: false, error: 'window_not_raised', message: "A new session is open in Claude's main window, but macOS didn't let Orbit bring it to the front.", sessionTitle: title });
          return out({ ok: true, created: false, newSession: true, folder: page.folder, windowId: target.hwnd, message: 'A new session is already open and empty.' });
        }
        button = sidebarButtonNamed(target, 'New');
      }
      if (!button) return out({ ok: false, error: 'new_button_not_found', message: "Couldn't find Claude's New session button. Is the sidebar hidden?", sessionTitle: ttitle });
      await press(target, button);
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        if (!(await refresh(target))) continue;
        const now = target.title;
        const page = newSessionPage(target, now);
        box = promptBox(target);
        if (page && box && !boxText(box)) {
          if (target !== front && !(await showWindow(target))) return out({ ok: false, error: 'window_not_raised', message: "Started a new session in Claude's main window, but macOS didn't let Orbit bring it to the front.", sessionTitle: title });
          return out({ ok: true, created: true, newSession: true, folder: page.folder, windowId: target.hwnd });
        }
      }
      return out({ ok: false, error: 'new_session_not_confirmed', message: "Pressed New session, but Claude didn't show an empty new session.", sessionTitle: target.title ?? null });
    }

    /** The front window, or the one window showing the expected session: { target } or { error }. */
    const expected = (missing) => {
      if (!a.ExpectTitleB64) return { target: front };
      const expect = decode(a.ExpectTitleB64);
      const targets = wins.filter((w) => w.title === expect);
      if (targets.length !== 1) return { error: targets.length ? 'session_ambiguous' : missing, count: targets.length };
      return { target: targets[0] };
    };

    if (mode === 'pending' || mode === 'answer') {
      const ex = expected('session_not_open');
      if (ex.error) return out({ ok: false, error: ex.error, message: ex.count ? 'That session is open in more than one Claude window.' : 'That session is not open in a Claude window.', sessionTitle: title });
      const w = ex.target;
      await useWindow(w, { full: true });
      title = w.title;
      if (mode === 'pending') {
        const p = pending(w);
        return out({ ok: true, sessionTitle: title, windowId: w.hwnd, pending: p ? p.info : null, count: p ? p.count : 0 });
      }
      const key = a.KeyB64 ? decode(a.KeyB64) : '';
      const hitCard = key ? cardByKey(w, key) : null;
      if (!hitCard) {
        const now = pending(w);
        return out({ ok: false, error: now ? 'prompt_changed' : 'nothing_pending', message: now ? 'What Claude is asking changed since it was read, so nothing was pressed.' : "Claude isn't waiting on anything in this session now.", pending: now ? now.info : null, sessionTitle: title });
      }
      const { card, info } = hitCard;
      const choice = a.Choice || '';
      let pressedName = '';
      if (info.kind === 'permission') {
        if (!['allow_once', 'allow_session', 'allow_always', 'deny'].includes(choice)) return out({ ok: false, error: 'bad_choice', message: 'This is a permission request: allow or deny it.', sessionTitle: title });
        const btn = buttonsIn(w, card).find((b) => enabled(b) && answerKind(nameOf(b)) === choice);
        if (!btn) return out({ ok: false, error: 'choice_not_offered', message: 'Claude does not offer that answer here.', options: info.options, sessionTitle: title });
        pressedName = nameOf(btn);
        if (!(await press(w, btn))) return out({ ok: false, error: 'not_pressable', message: "That button can't be pressed from here.", sessionTitle: title });
      } else if (choice === 'skip') {
        const btn = buttonsIn(w, card).find((b) => nameOf(b) === 'Skip');
        if (!btn) return out({ ok: false, error: 'choice_not_offered', message: 'This question has no Skip.', sessionTitle: title });
        pressedName = 'Skip';
        await press(w, btn);
      } else if (choice === 'option') {
        const option = Math.floor(Number(a.Option) || 0);
        if (option < 1 || option > info.choices.length) return out({ ok: false, error: 'bad_option', message: `There's no option ${option}.`, choices: info.choices, sessionTitle: title });
        let opts = buttonsIn(w, card).filter((b) => hasClass(b, 'epitaxy-answer-option'));
        if (!opts.length) opts = buttonsIn(w, card).filter((b) => nameOf(b) !== 'Other' && isToggle(b));
        const o = opts[option - 1];
        pressedName = info.choices[option - 1].label;
        if (!pressed(o)) await press(w, o);
        let sent = false;
        for (let i = 0; i < 20 && !sent; i++) {
          await refresh(w, { full: true });
          const again = cardByKey(w, key);
          if (!again) break;
          const sub = buttonsIn(w, again.card).find((b) => ['Submit', 'Next'].includes(nameOf(b)) && enabled(b));
          if (sub) {
            await press(w, sub);
            sent = true;
            break;
          }
          await sleep(100);
        }
        if (!sent) return out({ ok: false, error: 'submit_not_found', message: "Picked the option, but couldn't press Submit.", sessionTitle: title });
      } else {
        return out({ ok: false, error: 'bad_choice', message: 'This is a question: pick an option, or skip it.', choices: info.choices, sessionTitle: title });
      }
      let gone = false;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        await refresh(w, { full: true });
        if (!cardByKey(w, key)) {
          gone = true;
          break;
        }
      }
      const next = pending(w);
      return out({ ok: true, answered: true, pressed: pressedName, confirmed: gone, sessionTitle: title, next: next ? next.info : null });
    }

    if (mode === 'stop') {
      const ex = expected('session_changed');
      if (ex.error) return out({ ok: false, error: ex.error, message: 'That session is not open in exactly one Claude window, so nothing was stopped.', sessionTitle: title });
      const w = ex.target;
      title = w.title;
      const box = promptBox(w);
      if (!box) return out({ ok: false, error: 'prompt_box_not_found', message: 'No prompt box is visible, so there is no Stop button to press.', sessionTitle: title });
      const stop = sendButton(w, box, { names: STOP_NAMES });
      if (!stop) return out({ ok: false, error: 'not_working', message: "Claude isn't working in this session (there's no Stop button), so there was nothing to stop.", sessionTitle: title });
      if (!/I/.test(String(stop.pat || '')) || !(await press(w, stop))) return out({ ok: false, error: 'stop_not_pressable', message: "Claude's Stop button can't be pressed from here.", sessionTitle: title });
      let confirmed = false;
      for (let i = 0; i < 25; i++) {
        await sleep(100);
        if (!(await refresh(w))) continue;
        const b = promptBox(w);
        if (b && !sendButton(w, b, { names: STOP_NAMES })) {
          confirmed = true;
          break;
        }
      }
      return out({ ok: true, stopped: true, confirmed, sessionTitle: title, windowId: w.hwnd });
    }

    if (mode === 'app') return appAction(a, front, title);

    if (mode === 'send') return send(a, wins, front, title);

    return out({ ok: false, error: 'bad_mode', message: `Unknown mode ${mode}.` });
  }

  // ---- app: Claude's own controls (see desktop.ps1 "---- app ----") ----
  async function appAction(a, front, title) {
    const w = front;
    const action = a.Action || '';
    const value = a.ValueB64 ? decode(a.ValueB64).trim() : '';
    await useWindow(w, { full: ['scroll', 'load_earlier'].includes(action) });
    const nodes = () => appNodes(w);
    const all = (t) => nodes().filter((n) => n.t === t);
    const buttons = () => all('Button');
    const menuItems = async () => {
      for (let i = 0; i < 15; i++) {
        await refresh(w, { full: w.full });
        const items = all('MenuItem').filter((n) => enabled(n) && nameOf(n));
        if (items.length) return items;
        await sleep(100);
      }
      return [];
    };
    const expand = async (b) => !!(await act(w, b, 'expand')) || press(w, b);
    const collapse = async (b) => {
      try {
        await act(w, b, 'collapse');
      } catch {}
    };
    const status = () => {
      const bs = buttons();
      const modelBtn = bs.find((b) => /^Model: /.test(nameOf(b)));
      const permBtn = bs.find((b) => PERM_LIKE.test(nameOf(b)) && /E/.test(String(b.pat || '')));
      const sideBtn = bs.find((b) => ['Hide sidebar', 'Show sidebar'].includes(nameOf(b)));
      const modeGrp = nodes().find((n) => n.t === 'Group' && nameOf(n) === 'Mode');
      let tab = null;
      if (modeGrp) for (const r of w.tree.descendants(modeGrp)) if (r.t === 'RadioButton' && r.sel) tab = nameOf(r) === 'Code' ? 'code' : 'chat';
      const panels = {};
      for (const [k, name] of Object.entries(PANELS)) {
        const b = bs.find((x) => nameOf(x) === name && isToggle(x));
        if (b) panels[k] = pressed(b);
      }
      const page = newSessionPage(w, title);
      const scroller = chatScroller();
      return {
        modelBtn,
        permBtn,
        sideBtn,
        modeGrp,
        data: { ok: true, sessionTitle: title, windowId: w.hwnd, sidebar: sideBtn ? nameOf(sideBtn) === 'Hide sidebar' : null, tab, model: modelBtn ? nameOf(modelBtn).slice(7) : null, permission: permBtn ? nameOf(permBtn) : null, panels, newSession: !!page, folder: page ? page.folder : null, canScroll: !!scroller, canLoadEarlier: bs.some((b) => nameOf(b) === 'Load earlier messages') },
      };
    };
    // The conversation: the "Chat messages" group, and its messages (articles) for scrolling.
    function chatScroller() {
      return nodes().find((n) => n.t === 'Group' && nameOf(n) === 'Chat messages') || null;
    }
    const s = status();

    switch (action) {
      case 'status':
        return s.data;
      case 'folders': {
        const page = newSessionPage(w, title);
        return { ok: true, folders: newInFolderButtons(w).map((f) => ({ folder: f.folder, group: f.group })).slice(0, 30), newSession: !!page, folder: page ? page.folder : null, sessionTitle: title };
      }
      case 'sidebar': {
        if (!s.sideBtn) return { ok: false, error: 'control_not_found', message: "Couldn't find Claude's sidebar button." };
        const shown = nameOf(s.sideBtn) === 'Hide sidebar';
        const want = value === 'show' ? true : value === 'hide' ? false : !shown;
        if (want !== shown) await press(w, s.sideBtn);
        let ok = false;
        for (let i = 0; i < 15 && !ok; i++) {
          await sleep(100);
          await refresh(w);
          ok = buttons().some((b) => nameOf(b) === (want ? 'Hide sidebar' : 'Show sidebar'));
        }
        return { ok, sidebar: want, changed: want !== shown, error: ok ? null : 'not_confirmed', sessionTitle: title };
      }
      case 'tab': {
        const want = value === 'chat' ? 'Claude' : 'Code';
        const r = s.modeGrp ? w.tree.descendants(s.modeGrp).find((n) => (n.t === 'RadioButton' || isButton(n)) && nameOf(n) === want) : null;
        if (!r) return { ok: false, error: 'control_not_found', message: "Couldn't find Claude's Code / chat switch." };
        if (r.sel) return { ok: true, tab: value, changed: false, sessionTitle: title };
        await press(w, r);
        let ok = false;
        for (let i = 0; i < 15 && !ok; i++) {
          await sleep(100);
          await refresh(w);
          const r2 = all('RadioButton').find((n) => nameOf(n) === want);
          ok = !!r2?.sel;
        }
        return { ok, tab: value, changed: true, error: ok ? null : 'not_confirmed' };
      }
      case 'panel': {
        const [which, how] = value.split(':');
        const name = PANELS[which];
        const b = name ? buttons().find((x) => nameOf(x) === name && isToggle(x)) : null;
        if (!b) return { ok: false, error: 'control_not_found', message: "Couldn't find that panel's button." };
        const on = pressed(b);
        const want = how === 'on' ? true : how === 'off' ? false : !on;
        if (want !== on) await press(w, b);
        await sleep(150);
        await refresh(w);
        const b2 = buttons().find((x) => nameOf(x) === name && isToggle(x));
        const now = b2 ? pressed(b2) : on;
        return { ok: now === want, panel: which, on: now, changed: want !== on, sessionTitle: title };
      }
      case 'scroll': {
        const sc = chatScroller();
        if (!sc) return { ok: false, error: 'control_not_found', message: "Couldn't find the conversation to scroll." };
        const view = rectOf(w.tree.parent(sc)) || rectOf(sc);
        const msgs = w.tree.descendants(sc).filter((n) => n.sr === 'AXDocumentArticle');
        if (!msgs.length) return { ok: true, before: 100, after: 100, atTop: true, atBottom: true, sessionTitle: title };
        const visible = msgs.map((m, k) => ({ m, k, r: rectOf(m) })).filter((x) => x.r && view && x.r.y + x.r.h > view.y && x.r.y < view.y + view.h);
        const pct = (k) => Math.round((k / Math.max(1, msgs.length - 1)) * 1000) / 10;
        const first = visible.length ? visible[0].k : 0;
        const last = visible.length ? visible[visible.length - 1].k : msgs.length - 1;
        const before = pct(first);
        let to = null;
        if (value === 'top') to = 0;
        else if (value === 'bottom') to = msgs.length - 1;
        else if (value === 'down') to = Math.min(msgs.length - 1, last + 1);
        else to = Math.max(0, first - 1);
        await act(w, msgs[to], 'show');
        await sleep(150);
        const after = pct(to);
        return { ok: true, before, after, atTop: to === 0, atBottom: to === msgs.length - 1, sessionTitle: title };
      }
      case 'load_earlier': {
        const b = buttons().find((x) => nameOf(x) === 'Load earlier messages');
        if (!b) return { ok: false, error: 'nothing_earlier', message: 'There are no earlier messages to load.' };
        return { ok: await press(w, b), sessionTitle: title };
      }
      case 'model':
      case 'permission': {
        const btn = action === 'model' ? s.modelBtn : s.permBtn;
        if (!btn) return { ok: false, error: 'control_not_found', message: action === 'model' ? "Couldn't find Claude's model picker." : "Couldn't find Claude's permission mode button." };
        const was = nameOf(btn);
        let rx = null;
        if (action === 'permission') {
          const src = { ask: '^(ask|default)', accept_edits: 'accept edits|edit automatically|auto-?accept', plan: 'plan', bypass: 'bypass' }[value];
          if (!src) return { ok: false, error: 'bad_value', message: 'Unknown permission mode.' };
          rx = new RegExp(src, 'i');
          if (rx.test(was)) return { ok: true, changed: false, permission: was, sessionTitle: title };
        } else if (was.toLowerCase().includes(value.toLowerCase())) {
          return { ok: true, changed: false, model: was.slice(7), sessionTitle: title };
        }
        const match = (n) => (action === 'model' ? n.toLowerCase().includes(value.toLowerCase()) : rx.test(n));
        if (!(await expand(btn))) return { ok: false, error: 'not_pressable', message: "That picker can't be opened from here." };
        const items = await menuItems();
        const names = items.map(nameOf).slice(0, 20);
        let hits = items.filter((n) => match(nameOf(n)));
        if (hits.length > 1 && action === 'model') hits = [hits.sort((x, y) => nameOf(x).length - nameOf(y).length)[0]];
        if (hits.length !== 1) {
          const again = buttons().find((b) => nameOf(b) === was);
          if (again) await collapse(again);
          return { ok: false, error: hits.length ? 'ambiguous' : 'not_offered', message: hits.length ? 'More than one choice matches that.' : "Claude's picker has no choice like that.", options: names, sessionTitle: title };
        }
        const picked = nameOf(hits[0]);
        await press(w, hits[0]);
        let now = was;
        for (let i = 0; i < 20; i++) {
          await sleep(100);
          await refresh(w);
          const b2 = action === 'model' ? buttons().find((b) => /^Model: /.test(nameOf(b))) : buttons().find((b) => PERM_LIKE.test(nameOf(b)));
          if (b2) now = nameOf(b2);
          if (now !== was) break;
        }
        return { ok: now !== was, picked, now: action === 'model' && /^Model: /.test(now) ? now.slice(7) : now, error: now !== was ? null : 'not_confirmed', sessionTitle: title };
      }
      case 'rename':
      case 'archive':
      case 'delete': {
        const target = a.TitleB64 ? decode(a.TitleB64).trim() : title;
        if (!target) return { ok: false, error: 'no_session', message: 'No session is open to do that to.' };
        const rowsNow = () => sidebarSessions(w).map((r) => r.title);
        const more = buttons().filter((b) => nameOf(b) === `More options for ${target}`);
        if (action === 'rename') {
          if (!value) return { ok: false, error: 'no_name', message: 'Say what to call it.' };
          const hdr = buttons().find((b) => nameOf(b) === `${target}, rename session`);
          let opened = false;
          if (hdr) opened = await press(w, hdr);
          else if (more.length && (await expand(more[0]))) {
            const it = (await menuItems()).filter((n) => /^rename/i.test(nameOf(n)));
            if (it.length) opened = await press(w, it[0]);
            else await collapse(more[0]);
          }
          if (!opened) return { ok: false, error: 'control_not_found', message: "Couldn't find how to rename that session." };
          let edit = null;
          for (let i = 0; i < 15 && !edit; i++) {
            await sleep(100);
            await refresh(w);
            edit = all('Edit').find((n) => nameOf(n) !== 'Prompt' && nameOf(n) !== 'Find in page' && String(n.v ?? '') === target) || null;
          }
          if (!edit) return { ok: false, error: 'rename_field_not_found', message: "Opened the rename, but couldn't find its text field." };
          await act(w, edit, 'set_text', value);
          await refresh(w);
          const save = buttons().find((b) => ['Save', 'Done', 'Rename', 'Confirm'].includes(nameOf(b)));
          if (save) await press(w, save);
          else {
            const box = promptBox(w);
            if (box) await act(w, box, 'focus');
          }
          let ok = false;
          for (let i = 0; i < 20 && !ok; i++) {
            await sleep(100);
            await refresh(w);
            ok = rowsNow().includes(value) || w.title === value;
          }
          return { ok, renamed: ok, from: target, to: value, error: ok ? null : 'not_confirmed', sessionTitle: w.title };
        }
        if (!more.length) return { ok: false, error: 'session_not_in_sidebar', message: "Couldn't find that session's options.", sessionTitle: title };
        // The sidebar row's own button when it's there (the header's is the open session's).
        const mb = more.filter((b) => inSidebarTree(w, b)).pop() || more[0];
        if (!(await expand(mb))) return { ok: false, error: 'not_pressable', message: "That session's options can't be opened from here." };
        const want = action === 'archive' ? /^archive/i : /^delete/i;
        const it = (await menuItems()).filter((n) => want.test(nameOf(n)));
        if (!it.length) {
          const again = buttons().find((b) => nameOf(b) === `More options for ${target}`);
          if (again) await collapse(again);
          return { ok: false, error: 'not_offered', message: "Claude doesn't offer that for this session.", sessionTitle: title };
        }
        await press(w, it[0]);
        if (action === 'delete') {
          let confirm = null;
          for (let i = 0; i < 15 && !confirm; i++) {
            await sleep(100);
            await refresh(w);
            confirm = buttons().find((b) => nameOf(b) === 'Delete' && enabled(b)) || null;
          }
          if (!confirm) return { ok: false, error: 'confirm_not_found', message: "Claude didn't show its delete confirmation, so nothing was deleted.", sessionTitle: title };
          await press(w, confirm);
        }
        let gone = false;
        for (let i = 0; i < 20 && !gone; i++) {
          await sleep(100);
          await refresh(w);
          gone = !rowsNow().includes(target);
        }
        return { ok: gone, done: action, session: target, error: gone ? null : 'not_confirmed', sessionTitle: w.title };
      }
      default:
        return { ok: false, error: 'bad_action', message: 'Unknown app action.' };
    }
  }

  // ---- send / fill / clear (see desktop.ps1 "---- send ----") ----
  async function send(a, wins, front, title) {
    let target = front;
    let expect = null;
    if (a.ExpectTitleB64) {
      expect = decode(a.ExpectTitleB64);
      const targets = wins.filter((w) => w.title === expect);
      if (!targets.length) return { ok: false, error: 'session_changed', message: 'The session this prompt was drafted for is no longer open in any Claude window, so nothing was sent.', sessionTitle: title };
      if (targets.length > 1) return { ok: false, error: 'session_ambiguous', message: 'That session is open in more than one Claude window, so nothing was sent. Close one of them and ask again.', sessionTitle: title };
      target = targets[0];
    }
    const wantFolder = a.ExpectFolderB64 ? decode(a.ExpectFolderB64) : null;
    const newPageOk = (w) => {
      if (w.title) return null;
      const p = newSessionPage(w, null);
      return p && p.folder && (wantFolder === null || p.folder === wantFolder) ? p : null;
    };
    if (a.ExpectNew) {
      const targets = wins.filter((w) => newPageOk(w));
      if (!targets.length) return { ok: false, error: 'session_changed', message: 'The new session this prompt was drafted for is no longer open (or is now in a different folder), so nothing was sent.', sessionTitle: title };
      if (targets.length > 1) return { ok: false, error: 'session_ambiguous', message: 'More than one Claude window shows a new session, so nothing was sent. Close one of them and ask again.', sessionTitle: title };
      target = targets[0];
    }
    const w = target;
    title = w.title;
    let box = promptBox(w);
    if (!box) return { ok: false, error: 'prompt_box_not_found', message: 'No prompt box is visible. Open a Code session in the Claude app.', sessionTitle: title };
    const text = decode(a.TextB64);
    if (!text.trim()) return { ok: false, error: 'empty_text' };
    const inBox = boxText(box);
    const clearBox = async () => {
      const b = promptBox(w);
      if (b) await setBox(w, b, '');
    };
    /** Look again, and find the box again. */
    const again = async () => {
      await refresh(w);
      box = promptBox(w);
      return box;
    };

    if (a.Clear) {
      if (inBox && same(inBox, text)) {
        await setBox(w, box, '');
        return { ok: true, cleared: true, sessionTitle: title };
      }
      return { ok: true, cleared: false, sessionTitle: title };
    }

    if (a.Filled) {
      if (!same(inBox, text)) return { ok: false, error: 'prompt_box_changed', message: "The text in Claude's prompt box isn't the draft any more (it was edited or cleared), so nothing was sent.", sessionTitle: title };
    } else {
      const mayReplace = !!a.PrevB64 && !!inBox && same(inBox, decode(a.PrevB64));
      if (inBox && !mayReplace) return { ok: false, error: 'prompt_box_not_empty', message: 'The prompt box already has text in it, so nothing was typed there (to avoid wiping a draft).', sessionTitle: title };
      if (box.ro) return { ok: false, error: 'prompt_box_read_only', message: "Claude's prompt box isn't accepting input right now.", sessionTitle: title };
      if (mayReplace) {
        await setBox(w, box, '');
        await sleep(60);
        if (!(await again()) || boxText(box)) return { ok: false, error: 'prompt_box_not_cleared', message: "Couldn't clear the earlier draft from Claude's prompt box, so the new one wasn't typed in (it would have been added to the old one).", sessionTitle: title };
      }
      await setBox(w, box, text);
      await sleep(250);
      await again();
      const landed = box ? boxText(box) : '';
      let probe = text.trim().split('\n')[0].trim();
      if (probe.length > 30) probe = probe.slice(0, 30);
      const alone = same(landed, text) || landed.length <= text.trim().length + 20;
      if (!(landed && normText(landed).includes(normText(probe)) && alone)) {
        try {
          await clearBox();
        } catch {}
        return { ok: false, error: 'fill_not_verified', message: "Couldn't confirm the text reached Claude's prompt box (on its own), so nothing was sent.", sessionTitle: title };
      }
    }

    // The same session still open in this window, right before Send.
    await refresh(w);
    box = promptBox(w) || box;
    const still = w.title;
    const stillOk = expect !== null ? still === expect : a.ExpectNew ? !still && !!newSessionPage(w, null) : still === title;
    if (!stillOk) {
      if (!a.Filled) {
        try {
          await clearBox();
        } catch {}
      }
      return { ok: false, error: 'session_changed', message: 'The session changed while the prompt was being typed in, so nothing was sent.', sessionTitle: still };
    }

    if (a.Fill) return { ok: true, filled: true, sent: false, sessionTitle: title, windowId: w.hwnd };

    if (a.DryRun) {
      await clearBox();
      return { ok: true, sent: false, dryRun: true, sessionTitle: title, windowId: w.hwnd };
    }

    const sendBtn = sendButton(w, box);
    if (!sendBtn) {
      const why = sendButton(w, box, { names: STOP_NAMES }) ? 'claude_working' : sendButton(w, box, { anyState: true }) ? 'send_disabled' : 'not_found';
      if (!a.Filled) {
        try {
          await clearBox();
        } catch {}
      }
      const msg = { claude_working: 'Claude is still working in that session (its Stop button is where Send goes), so nothing was sent.', send_disabled: "Claude's Send button is there but turned off, so nothing was sent." }[why] || "Couldn't find Claude's Send button, so nothing was sent.";
      return { ok: false, error: 'send_button_not_found', why, message: msg, draftKept: !!a.Filled, sessionTitle: title };
    }
    await press(w, sendBtn);

    let confirmed = false;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if ((await again()) && !boxText(box)) {
        confirmed = true;
        break;
      }
    }
    if (a.ExpectNew) {
      for (let i = 0; i < 30 && !title; i++) {
        await sleep(100);
        await refresh(w);
        title = w.title;
      }
    }
    return { ok: true, sent: true, confirmed, sessionTitle: title, newSession: !!a.ExpectNew, windowId: w.hwnd };
  }

  return { run };
}
