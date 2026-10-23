// The Claude desktop app's own controls by voice (desktop.ps1 -Mode app): its model picker,
// permission mode, sidebar, Code / chat switch, panels, scrolling, and renaming, archiving and
// deleting sessions. One tool with an `action`, so the voice's prompt stays lean.
//
// Every change needs the user's own fresh words asking for that very thing (checked here, not left
// to the model), once per request, never a notification, a transcript or a web page. Deleting a
// session, and turning on "bypass permissions" (Claude then runs anything without asking), also
// need a spoken yes after Orbit asks.

import { claudeApp } from './desktop.js';

export const APP_TOOL_DEF = {
  type: 'function',
  name: 'claude_app',
  description:
    'Use the Claude desktop app\x27s own controls, only when the user just asked for that in their own words. action: status (read only: Claude\x27s model, permission mode, sidebar, Code or chat, panels); model (Claude\x27s own model picker for the session, value like "sonnet" or "opus": Claude\x27s model, not your own voice); permission (value ask, accept_edits, plan or bypass); sidebar (show or hide); tab (code or chat); panel (value terminal, changes, browser or files, plus ":on" or ":off"); scroll (up, down, top or bottom); load_earlier; rename (value: the new title, in their words); archive; delete. For rename, archive or delete of a session that isn\x27t the open one, give its title words as session. delete and bypass ask the user first: say the question, then call again only after their yes. Not for work in their project ("add a sidebar to my app" is a prompt).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'model', 'permission', 'sidebar', 'tab', 'panel', 'scroll', 'load_earlier', 'rename', 'archive', 'delete'] },
      value: { type: 'string', description: 'What to set: a model, a mode, show / hide, code / chat, a panel, a direction, a new title.' },
      session: { type: 'string', description: 'For rename / archive / delete: title words of the session, when it is not the one open in Claude.' },
    },
    required: ['action'],
  },
};

const NEGATION = /\b(don'?t|do not|not|never|no)\b/i;
const MODEL_FAMILY = /\b(opus|sonnet|haiku|fable)\b/i;
const MODES = {
  ask: /\b(ask|asks|asking|default|normal|regular|permission prompts?)\b/i,
  accept_edits: /\b(accept|edits?|edit automatically|auto(?:matic(?:ally)?)?)\b/i,
  plan: /\bplan(ning)?\b/i,
  bypass: /\b(bypass|skip (the )?permissions?|yolo|dangerous(ly)?)\b/i,
};
const PANELS = { terminal: /\bterminal\b/i, changes: /\b(changes|diff|diffs)\b/i, browser: /\bbrowser\b/i, files: /\b(files|file tree|file list)\b/i };

/** Do the user's own words ask for this action (and this value)? */
export function asksApp(action, words, value = '') {
  const w = String(words || '');
  const v = String(value || '').toLowerCase();
  if (!w.trim()) return false;
  switch (action) {
    case 'status':
      return true;
    case 'model': {
      // Claude's model: words name the model and mean Claude's ("switch Claude to Sonnet", "set the model to Opus").
      // (A model Claude may not offer, "GPT", still opens the picker: Orbit then says what it does offer.)
      const fam = v.match(MODEL_FAMILY)?.[1] || v.split(/\s+/)[0].replace(/[^a-z0-9.-]/g, '');
      return !!fam && new RegExp(`\\b${fam.replace(/[.-]/g, '\\$&')}\\b`, 'i').test(w) && /\b(claude'?s?|the model|its model|model|session|code)\b/i.test(w) && !NEGATION.test(w);
    }
    case 'permission':
      return Object.hasOwn(MODES, v) && MODES[v].test(w) && /\b(mode|permissions?|plan|accept|bypass|ask|edits?|yolo)\b/i.test(w) && !NEGATION.test(w.replace(/\bask (me )?(before|first)\b/gi, ''));
    case 'sidebar':
      return /\bside ?bar\b|\bsession list\b/i.test(w) && !NEGATION.test(w);
    case 'tab':
      return (v === 'chat' ? /\b(chat|claude tab|regular claude|claude\.ai)\b/i : /\b(code|claude code)\b/i).test(w) && /\b(tab|mode|switch|go|open|back|view|show)\b/i.test(w) && !NEGATION.test(w);
    case 'panel': {
      const p = v.split(':')[0];
      return Object.hasOwn(PANELS, p) && PANELS[p].test(w) && !/\bdon'?t\b/i.test(w);
    }
    case 'scroll':
      return /\b(scroll|up|down|top|bottom|earlier|older|latest|newest|back up)\b/i.test(w) && !/\bdon'?t\b/i.test(w);
    case 'load_earlier':
      return /\b(earlier|older|more|previous|before|history|scroll)\b/i.test(w);
    case 'rename':
      return /\b(rename|re-?name|call (it|this|the session)|name (it|this|the session)|title)\b/i.test(w) && !NEGATION.test(w);
    case 'archive':
      return /\barchiv/i.test(w) && !NEGATION.test(w);
    case 'delete':
      return /\b(delete|remove|trash|get rid of)\b/i.test(w) && /\b(session|thread|chat|conversation|it|this|that|one)\b/i.test(w) && !NEGATION.test(w);
  }
  return false;
}

const ASK_MAX_AGE_MS = 2 * 60 * 1000;
const CONFIRM_MAX_AGE_MS = 60_000;
const WORD = (s) => String(s).toLowerCase().replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The claude_app handler for one connection. `recentUtterance()`: the user's latest words
 * ({ text, at }); `lastOutsideAt()`: when a notification or outside data last came in;
 * `isClearYes(text)`; `currentTitle()`: the open session's title (for the delete question);
 * `resolveTitle(words)`: a session's exact title; `notify(event)`.
 */
export function createAppControl({ recentUtterance, lastOutsideAt, isClearYes, currentTitle, resolveTitle, notify = () => {}, app = claudeApp }) {
  const used = new Map(); // action -> the `at` of the words that already did it
  let pending = null; // { action, value, title, at }: a delete or bypass Orbit asked about

  return async function claude_app({ action, value, session } = {}) {
    const a = String(action || '');
    let v = String(value ?? '').trim().slice(0, 200);
    if (!APP_TOOL_DEF.parameters.properties.action.enum.includes(a)) return { ok: false, error: 'Unknown action.' };
    if (a === 'status') {
      const r = await app('status');
      return r.ok ? { ...r, note: 'What Claude\x27s window shows now. Read only.' } : r;
    }
    if (a === 'permission') v = v.toLowerCase().replace(/[\s-]+/g, '_').replace(/^accept$|^auto$|^edits$/, 'accept_edits');
    if (a === 'sidebar' || a === 'tab' || a === 'scroll') v = v.toLowerCase();
    if (a === 'panel') v = v.toLowerCase().replace(/\s+/g, '');
    const asked = recentUtterance();
    const words = String(asked?.text || '');
    const needsYes = a === 'delete' || (a === 'permission' && v === 'bypass');
    const title = a === 'rename' || a === 'archive' || a === 'delete' ? (session ? resolveTitle(String(session)) : '') || '' : '';

    // The second step of a delete / bypass: the user's yes after Orbit asked.
    if (needsYes && pending && pending.action === a && (a !== 'delete' || !title || title === pending.title)) {
      const fresh = asked && asked.at > pending.at && Date.now() - asked.at <= CONFIRM_MAX_AGE_MS && lastOutsideAt() < pending.at;
      if (fresh && isClearYes(words)) {
        const p = pending;
        pending = null;
        const r = await app(a, { value: p.value, title: p.title });
        if (r.ok) notify({ type: 'bridge.app', action: a, value: p.value });
        return r.ok ? { ok: true, done: a, session: p.title || undefined, next_step: 'Say in a few words that it\x27s done.' } : r;
      }
      if (fresh && asked.at !== pending.askedWith) {
        pending = null;
        return { ok: false, error: 'Not done: the user didn\x27t say yes.', next_step: 'Say it was left alone.' };
      }
    }

    if (!asked || Date.now() - asked.at > ASK_MAX_AGE_MS || used.get(a) === asked.at || !asksApp(a, words, v)) {
      return { ok: false, error: 'Not done: only use Claude\x27s controls when the user has just asked for that very thing in their own words (each request does it once).' };
    }
    if (a === 'rename') {
      // The new title is the user's own words.
      const have = new Set(WORD(words));
      if (!v || WORD(v).some((x) => !have.has(x))) return { ok: false, error: 'Not renamed: the new title must be the user\x27s own words. Ask what to call it.' };
    }
    if (needsYes) {
      const t = a === 'delete' ? title || (await currentTitle()) || '' : '';
      if (a === 'delete' && !t) return { ok: false, error: 'No session is open to delete.' };
      used.set(a, asked.at);
      pending = { action: a, value: v, title: t, at: Date.now(), askedWith: asked.at };
      return {
        confirm_needed: true,
        next_step:
          a === 'delete'
            ? `Ask in a few words: "Delete ${t}? It can't be undone." Call claude_app with action delete again only after a clear yes.`
            : 'Ask in a few words: "Turn on bypass permissions? Claude won\x27t ask before running anything." Call claude_app again only after a clear yes.',
      };
    }
    used.set(a, asked.at);
    const r = await app(a, { value: v, title });
    if (r.ok) notify({ type: 'bridge.app', action: a, value: v });
    if (!r.ok) {
      if (r.error === 'not_offered' && Array.isArray(r.options)) return { ...r, options: r.options.slice(0, 12).map((x) => String(x).slice(0, 60)), next_step: 'Tell the user briefly which choices Claude offers.' };
      used.delete(a); // it didn't happen: the same request may try again
      return r;
    }
    return { ...r, next_step: 'Say in a few words that it\x27s done (or what changed).' };
  };
}
