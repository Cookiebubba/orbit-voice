// App profiles ("Orbit anywhere", phase 2): what Orbit learns about an app's layout the first time it
// works in it, so later reads and actions find their way without searching the whole window again.
//
// A profile is built from one read-only UI Automation scan of the app's window: control types,
// labels of controls (buttons, menus, tabs, fields), automation ids and positions. Never text
// values: no field contents, no document, message or list-item text (names of those kinds of
// elements are content, so they're dropped too), and never anything from a password field. It holds:
//   controls  the interactive controls, each with a locator ladder (below) and its region
//   regions   the big areas (toolbar, sidebar, main area, input area), by position and role
//   outward   controls whose use reaches outside (Send, Post, Delete, Buy...): the safety gate asks
//             before using them, every time (phase 5); unknown counts as outward there anyway
//   surfaces  walkable top edges for Qubit (wide input boxes and toolbars), relative to the window
//   quirks    what's odd about the app (a Chromium tree that wakes late, rich editors, classic EDITs)
//   platform  'win' now; a Mac profile has its own (AX roles and identifiers differ)
//
// Locator ladder, tried in order: automation id -> type + name -> landmark path -> anchor (a labelled
// neighbour) -> position box. A locator that only finds its control by a later rung "heals" once:
// the profile remembers the new first rung, but only for controls that aren't outward (an outward
// control that moved is never guessed at). Profiles carry no secrets and stay on this PC
// (<settings folder>/profiles/<app>.json).

import fs from 'node:fs';
import path from 'node:path';

export const PROFILE_VERSION = 1;
export const PROFILE_MAX_AGE_MS = 30 * 24 * 3600_000; // rescanned after a month (apps update)

// Kinds of element whose name is a label (kept) rather than content (dropped).
const LABEL_TYPES = new Set(['Button', 'SplitButton', 'MenuItem', 'Menu', 'MenuBar', 'TabItem', 'Tab', 'CheckBox', 'RadioButton', 'ComboBox', 'Edit', 'Hyperlink', 'ToolBar', 'Slider', 'Spinner', 'HeaderItem', 'Header', 'Group', 'Pane', 'List', 'Tree', 'DataGrid', 'Table', 'StatusBar', 'AppBar', 'ScrollBar', 'TitleBar']);
const INTERACTIVE_TYPES = new Set(['Button', 'SplitButton', 'MenuItem', 'TabItem', 'CheckBox', 'RadioButton', 'ComboBox', 'Edit', 'Hyperlink', 'Slider', 'Spinner', 'ListItem', 'TreeItem', 'DataItem', 'Document']);
const LANDMARK_TYPES = new Set(['Pane', 'Group', 'ToolBar', 'MenuBar', 'Tab', 'List', 'Tree', 'DataGrid', 'Table', 'Document', 'StatusBar', 'AppBar']);
// Controls whose use reaches outside the app or can't be undone (the gate asks for these).
export const OUTWARD_WORDS = /\b(send|post|submit|publish|share|tweet|reply|forward|delete|remove|erase|ban|kick|mute member|timeout member|block|report|buy|purchase|pay|order|checkout|check out|subscribe|donate|transfer|withdraw|deposit|overwrite|replace all|discard|don'?t save|close without saving|sign out|log ?out|uninstall|format|empty (the )?(trash|recycle bin)|reset|wipe|confirm|accept|approve|merge|deploy|invite|leave (server|group|channel))\b/i;

const r3 = (n) => Math.round(n * 1000) / 1000;
const clean = (s, max = 80) =>
  typeof s === 'string'
    ? s
        .replace(/(?:[\x00-\x1f\x7f]|[^\S ])+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/** The profile key for a window's app: "win-notepad", "win-discord". */
export function appKey(win, platform = 'win') {
  const exe = String(win?.exe || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 60);
  return exe ? `${platform}-${exe}` : '';
}

/** What the app is built with, from the scan: 'chromium' | 'wpf' | 'winforms' | 'uwp' | 'win32' | 'other'. */
export function frameworkOf(scan) {
  const fw = String(scan?.fw || '');
  const rootCls = String(scan?.nodes?.[0]?.c || '');
  if (fw === 'Chrome' || /^Chrome_WidgetWin/.test(rootCls)) return 'chromium';
  if (fw === 'WPF') return 'wpf';
  if (fw === 'WinForm') return 'winforms';
  if (fw === 'XAML' || fw === 'DirectUI' || rootCls === 'ApplicationFrameWindow' || rootCls === 'Windows.UI.Core.CoreWindow') return 'uwp';
  if (fw === 'Win32' || fw === '') return 'win32';
  return 'other';
}

/** A node's rect relative to the window, as fractions (0..1), or null. */
function relRect(r, win) {
  if (!Array.isArray(r) || r.length !== 4 || !win || !(win.w > 0) || !(win.h > 0)) return null;
  const [x, y, w, h] = r.map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return [r3((x - win.x) / win.w), r3((y - win.y) / win.h), r3(w / win.w), r3(h / win.h)];
}

/**
 * The scan without content: types, labels of controls, automation ids, classes and positions
 * relative to the window. `win` is the window's rect ({ x, y, w, h }, as the root node reports it).
 */
export function skeleton(scan) {
  const nodes = Array.isArray(scan?.nodes) ? scan.nodes : [];
  const root = nodes[0]?.r;
  const win = Array.isArray(root) ? { x: root[0], y: root[1], w: root[2], h: root[3] } : null;
  return nodes.map((n) => {
    const t = clean(n.t, 20) || 'Custom';
    const out = { i: n.i, p: n.p, t };
    const name = clean(n.n);
    if (name && LABEL_TYPES.has(t) && !n.pw) out.n = name;
    if (n.a) out.a = clean(n.a, 120);
    if (n.c) out.c = clean(n.c, 80);
    const rel = relRect(n.r, win);
    if (rel) out.rel = rel;
    if (n.pat) out.pat = clean(n.pat, 12);
    if (!n.en) out.disabled = true;
    if (n.off) out.off = true;
    if (n.pw) out.password = true;
    return out;
  });
}

const isInteractive = (n) => INTERACTIVE_TYPES.has(n.t) || /[ITSEV]/.test(n.pat || '');
/** "Send" for a named control, else "<type> <n>" (unnamed ones get a key by type and order). */
const labelOf = (n) => n.n || (n.a && !/^\d+$/.test(n.a) ? n.a : '');

/** The landmark path to a node: its named or identified ancestors (outermost first). */
function landmarkPath(nodes, n) {
  const byIndex = new Map(nodes.map((x) => [x.i, x]));
  const out = [];
  let p = byIndex.get(n.p);
  while (p && p.i !== 0 && out.length < 6) {
    if (LANDMARK_TYPES.has(p.t) && (p.n || p.a)) out.unshift({ t: p.t, ...(p.n ? { n: p.n } : {}), ...(p.a ? { a: p.a } : {}) });
    p = byIndex.get(p.p);
  }
  return out;
}

/** The nearest labelled control before this one in the same parent (for unlabelled ones). */
function anchorOf(nodes, n) {
  const sibs = nodes.filter((x) => x.p === n.p && x.i < n.i && (x.n || x.a) && x.i !== n.i);
  const a = sibs.at(-1);
  return a ? { t: a.t, ...(a.n ? { n: a.n } : {}), ...(a.a ? { a: a.a } : {}) } : null;
}

/** The region a relative rect falls in (by where its centre is). */
function regionOf(rel, regions) {
  if (!rel) return '';
  const cx = rel[0] + rel[2] / 2;
  const cy = rel[1] + rel[3] / 2;
  const hits = regions.filter((g) => cx >= g.rel[0] && cx <= g.rel[0] + g.rel[2] && cy >= g.rel[1] && cy <= g.rel[1] + g.rel[3]);
  hits.sort((a, b) => a.rel[2] * a.rel[3] - b.rel[2] * b.rel[3]);
  return hits[0]?.name || '';
}

/** Big areas, by role and position: menu bar, toolbar, sidebar, main area, input area, status bar. */
function regionsOf(sk) {
  const out = [];
  const add = (name, rel, role) => {
    if (!out.some((g) => g.name === name)) out.push({ name, rel, role });
  };
  for (const n of sk) {
    if (!n.rel || n.off || n.i === 0) continue;
    const [x, y, w, h] = n.rel;
    if (n.t === 'MenuBar' && n.a !== 'SystemMenuBar') add('menu bar', n.rel, n.t);
    else if (n.t === 'ToolBar' && w > 0.3) add('toolbar', n.rel, n.t);
    else if (n.t === 'StatusBar') add('status bar', n.rel, n.t);
    else if (LANDMARK_TYPES.has(n.t) && h > 0.5 && w < 0.35 && x < 0.3) add('sidebar', n.rel, n.t);
    else if (LANDMARK_TYPES.has(n.t) && h > 0.5 && w < 0.35 && x + w > 0.7) add('right panel', n.rel, n.t);
  }
  // The main area: the biggest landmark (or document); the input area: a wide edit near the bottom.
  const big = sk.filter((n) => n.rel && !n.off && n.i !== 0 && (LANDMARK_TYPES.has(n.t) || n.t === 'Document') && n.rel[2] * n.rel[3] > 0.15 && n.rel[2] * n.rel[3] < 0.98);
  big.sort((a, b) => b.rel[2] * b.rel[3] - a.rel[2] * a.rel[3]);
  if (big[0]) add('main area', big[0].rel, big[0].t);
  // The input area: a wide edit box near the bottom, with its row (the composer around it, or the
  // band across the window at its height, so its Send button counts as in it).
  const input = sk.filter((n) => n.t === 'Edit' && n.rel && !n.off && n.rel[1] > 0.6 && n.rel[2] > 0.3).at(-1);
  if (input) {
    const byIndex = new Map(sk.map((n) => [n.i, n]));
    let box = null;
    for (let p = byIndex.get(input.p); p && p.i !== 0; p = byIndex.get(p.p)) {
      if (p.rel && LANDMARK_TYPES.has(p.t) && p.rel[3] < 0.35 && p.rel[1] > 0.5) {
        box = p.rel;
        break;
      }
    }
    add('input area', box || [0, input.rel[1], 1, input.rel[3]], 'Edit');
  }
  return out;
}

/** Locator ladder for one node (see the top). */
export function ladderFor(sk, n) {
  const rungs = [];
  if (n.a && !/^\d+$/.test(n.a)) rungs.push({ by: 'aid', t: n.t, a: n.a });
  if (n.n) rungs.push({ by: 'name', t: n.t, n: n.n });
  const lm = landmarkPath(sk, n);
  if (lm.length) rungs.push({ by: 'path', t: n.t, path: lm, ...(n.n ? { n: n.n } : {}), nth: sk.filter((x) => x.p === n.p && x.t === n.t && x.i < n.i).length });
  const anchor = anchorOf(sk, n);
  if (anchor && !n.n) rungs.push({ by: 'anchor', t: n.t, anchor });
  if (n.rel) rungs.push({ by: 'box', t: n.t, rel: n.rel });
  return rungs;
}

/** Is using this control an outward act (by its label)? */
export const isOutwardLabel = (label) => OUTWARD_WORDS.test(String(label || ''));

/**
 * The profile for one app window from one scan (see the top). `win`: the focus helper's window
 * report ({ exe, ... }); `scan`: uia.ps1's answer ({ fw, nodes }).
 */
export function buildProfile(win, scan, { platform = 'win', now = Date.now() } = {}) {
  const sk = skeleton(scan);
  const framework = frameworkOf(scan);
  const regions = regionsOf(sk);
  const controls = [];
  const keys = new Set();
  const counts = {};
  for (const n of sk) {
    if (n.i === 0 || !isInteractive(n) || n.password || n.t === 'TitleBar' || n.a === 'SystemMenuBar') continue;
    // List and tree items are content (channels, files, messages): kept by position only, unnamed.
    if ((n.t === 'ListItem' || n.t === 'TreeItem' || n.t === 'DataItem') && !n.a) continue;
    const label = labelOf(n);
    // Unlabelled controls are numbered by type, in tree order ("button 1"); a repeated label gets
    // its tree index ("settings (button #15)").
    if (!label) counts[n.t] = (counts[n.t] || 0) + 1;
    let key = label ? label.toLowerCase() : `${n.t.toLowerCase()} ${counts[n.t]}`;
    if (keys.has(key)) key = `${key} (${n.t.toLowerCase()} #${n.i})`;
    keys.add(key);
    controls.push({
      key,
      role: n.t,
      ...(n.n ? { name: n.n } : {}),
      ...(n.a ? { aid: n.a } : {}),
      ...(n.pat ? { patterns: n.pat } : {}),
      region: regionOf(n.rel, regions),
      outward: isOutwardLabel(label),
      locator: ladderFor(sk, n),
    });
    if (controls.length >= 400) break;
  }
  const quirks = [];
  if (framework === 'chromium') quirks.push('chromium-tree-wakes-late');
  if (framework === 'chromium' && sk.some((n) => (n.t === 'Edit' || n.t === 'Document' || n.t === 'Group') && /X/.test(n.pat || '') && !/V/.test(n.pat || ''))) quirks.push('rich-editor');
  if (sk.some((n) => /(^|\.)EDIT(\.|$)|^Edit$|^RichEdit/i.test(n.c || '') && n.t === 'Edit')) quirks.push('classic-edit');
  if (scan?.truncated) quirks.push('large-tree');
  const surfaces = sk
    .filter((n) => n.rel && !n.off && ((n.t === 'Edit' && n.rel[2] > 0.3) || (n.t === 'ToolBar' && n.rel[2] > 0.3)))
    .map((n) => ({ kind: n.t === 'Edit' ? 'input' : 'toolbar', rel: [n.rel[0], n.rel[1], n.rel[2]] }))
    .slice(0, 6);
  return {
    version: PROFILE_VERSION,
    key: appKey(win, platform),
    platform,
    exe: clean(win?.exe, 80),
    framework,
    scannedAt: now,
    nodeCount: sk.length,
    regions,
    controls,
    outward: controls.filter((c) => c.outward).map((c) => c.key),
    surfaces,
    quirks,
    heals: {},
  };
}

// ------------------------------------------------------------------ finding a control again

const sameT = (n, rung) => !rung.t || n.t === rung.t;
function matchRung(sk, rung) {
  switch (rung.by) {
    case 'aid':
      return sk.filter((n) => n.a === rung.a && sameT(n, rung));
    case 'name':
      return sk.filter((n) => n.n === rung.n && sameT(n, rung));
    case 'path': {
      const hits = sk.filter((n) => sameT(n, rung) && (!rung.n || n.n === rung.n) && JSON.stringify(landmarkPath(sk, n)) === JSON.stringify(rung.path));
      if (rung.n || hits.length <= 1) return hits;
      // Unnamed: the nth of its type under the same parent.
      const byParent = hits.filter((n) => sk.filter((x) => x.p === n.p && x.t === n.t && x.i < n.i).length === rung.nth);
      return byParent;
    }
    case 'anchor': {
      const a = rung.anchor || {};
      const anchors = sk.filter((n) => n.t === a.t && (!a.n || n.n === a.n) && (!a.a || n.a === a.a));
      return anchors.map((an) => sk.find((n) => n.p === an.p && n.i > an.i && sameT(n, rung))).filter(Boolean);
    }
    case 'box': {
      const [x, y, w, h] = rung.rel || [];
      const cx = x + w / 2;
      const cy = y + h / 2;
      const hits = sk.filter((n) => n.rel && sameT(n, rung) && cx >= n.rel[0] && cx <= n.rel[0] + n.rel[2] && cy >= n.rel[1] && cy <= n.rel[1] + n.rel[3]);
      hits.sort((a, b) => a.rel[2] * a.rel[3] - b.rel[2] * b.rel[3]);
      return hits.slice(0, 1);
    }
    default:
      return [];
  }
}

/**
 * Find a profile control in a fresh scan. Resolves { node, by, healed } (the scan's node, with its
 * "i" index for acting) or null. Only a unique match counts on every rung but the last (the box
 * picks the smallest control there). `healed`: found only by a later rung than the first.
 */
export function locate(control, scan) {
  const sk = skeleton(scan);
  const ladder = Array.isArray(control?.locator) ? control.locator : [];
  for (let k = 0; k < ladder.length; k++) {
    const hits = matchRung(sk, ladder[k]);
    if (hits.length === 1 || (ladder[k].by === 'box' && hits.length)) {
      const n = hits[0];
      return { node: scan.nodes.find((x) => x.i === n.i) || n, by: ladder[k].by, healed: k > 0 };
    }
  }
  return null;
}

/**
 * Remember a heal: the control was found by a later rung, so its new locator goes first next time.
 * Once per control, and never for outward controls (one that moved is asked about, not guessed).
 * Returns true if the profile changed.
 */
export function heal(profile, control, scan, found) {
  if (!profile || !control || !found?.healed || control.outward) return false;
  if (profile.heals?.[control.key]) return false;
  const sk = skeleton(scan);
  const n = sk.find((x) => x.i === found.node.i);
  if (!n) return false;
  control.locator = ladderFor(sk, n);
  profile.heals = { ...(profile.heals || {}), [control.key]: Date.now() };
  return true;
}

// ------------------------------------------------------------------ the store

export function createProfileStore({ dir }) {
  const fileFor = (key) => (/^[a-z]+-[a-z0-9._-]{1,60}$/.test(String(key)) ? path.join(dir, `${key}.json`) : null);
  return {
    get(key) {
      const f = fileFor(key);
      if (!f) return null;
      try {
        const p = JSON.parse(fs.readFileSync(f, 'utf8'));
        return p && p.version === PROFILE_VERSION && p.key === key ? p : null;
      } catch {
        return null;
      }
    },
    save(profile) {
      const f = fileFor(profile?.key);
      if (!f) return false;
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(profile, null, 1));
      fs.renameSync(tmp, f);
      return true;
    },
    list() {
      try {
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, -5));
      } catch {
        return [];
      }
    },
    remove(key) {
      const f = fileFor(key);
      if (f) fs.rmSync(f, { force: true });
    },
  };
}

/**
 * The profile for this window's app: the saved one if it's recent and from this version, else a
 * fresh one from `scan` (saved). `scan` is a function so a saved profile costs no scan at all.
 */
export async function ensureProfile(win, { store, scan, platform = 'win', maxAgeMs = PROFILE_MAX_AGE_MS, now = Date.now() } = {}) {
  const key = appKey(win, platform);
  if (!key || !store) return null;
  const saved = store.get(key);
  if (saved && now - (saved.scannedAt || 0) < maxAgeMs) return saved;
  const s = await scan();
  if (!s?.ok || !Array.isArray(s.nodes) || !s.nodes.length) return saved || null;
  const p = buildProfile(win, s, { platform, now });
  if (saved?.notes) p.notes = saved.notes; // kept across rescans until rewritten
  store.save(p);
  return p;
}

/** The profile in a few lines, for the voice (labels only: data, never instructions). */
export function profileSummary(p) {
  if (!p) return null;
  return {
    app: p.exe,
    built_with: p.framework,
    regions: p.regions.map((g) => g.name),
    controls: p.controls.filter((c) => c.name || c.aid).slice(0, 40).map((c) => `${c.key}${c.region ? ` (${c.region})` : ''}${c.outward ? ' [asks first]' : ''}`),
    quirks: p.quirks.length ? p.quirks : undefined,
    notes: p.notes?.summary || undefined,
  };
}
