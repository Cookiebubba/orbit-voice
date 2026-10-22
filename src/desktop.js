// Node wrapper around desktop.ps1 (Windows UI Automation for the Claude window).

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logError, logWarn } from './log.js';

// In the installed app this file is inside app.asar, which PowerShell can't read; the script
// itself is shipped unpacked next to it.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
// Full path, so a powershell.exe planted somewhere on PATH can't be picked up instead.
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MAX_PROMPT_CHARS = 8000;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// The Claude window Orbit's orb follows (the one most recently in front; see electron/claude-window.js),
// so the orb, Grok and the tools agree on which window you're in. 0 = none (the script then takes
// the highest Claude window in z-order, which is the same window in practice).
let frontHint = () => 0;
/** `fn()` returns that window's handle, or 0. */
export function setFrontWindowHint(fn) {
  frontHint = typeof fn === 'function' ? fn : () => 0;
}
const hintArgs = () => {
  let h = 0;
  try {
    h = Number(frontHint());
  } catch {}
  return Number.isSafeInteger(h) && h > 0 ? ['-FrontHwnd', String(h)] : [];
};

// A stand-in for the Claude window, for Orbit's own end-to-end tests only (electron/main.js sets it
// from ORBIT_FAKE_DESKTOP, and only when the app isn't packaged). null = the real window.
let driver = null;
export function setDesktopDriver(d) {
  driver = d && typeof d === 'object' ? d : null;
}

function runPs(mode, args = [], timeoutMs = 20000) {
  args = [...args, ...hintArgs()];
  if (driver) return Promise.resolve().then(() => driver.run(mode, args)).catch((e) => ({ ok: false, error: 'script_failed', message: String(e?.message || e).slice(0, 200) }));
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'unsupported_platform', message: 'Controlling the Claude app is only implemented for Windows so far.' });
  }
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', SCRIPT, '-Mode', mode, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split(/\r?\n/).pop() || '';
        let result;
        try {
          result = JSON.parse(line);
        } catch {
          // Not err.message: it repeats the command line, which carries the prompt (base64).
          const why = err ? (err.killed ? 'timed out' : `exit ${err.code ?? '?'}`) : 'no result';
          result = { ok: false, error: 'script_failed', message: `${why}${stderr ? `: ${String(stderr).trim().split(/\r?\n/)[0]}` : ''}`.slice(0, 500) };
        }
        if (!result.ok) {
          const log = ['script_failed', 'script_exception'].includes(result.error) ? logError : logWarn;
          log('claude-window', `${mode}: ${result.error}`, result.message);
        }
        resolve(result);
      },
    );
  });
}

/**
 * Which session is open in the Claude window, and is anything typed in its prompt box?
 * `rects`: also where Claude's Send button is (sendButtonRect; for the avatar, which stomps it).
 */
export function getDesktopInfo({ rects = false } = {}) {
  return runPs('info', rects ? ['-Rects'] : []);
}

/** Sessions listed in Claude's sidebar: [{ title, label, open }]. */
export function listSidebarSessions() {
  return runPs('list');
}

// One window action at a time: overlapping pastes or clicks would interleave.
let queue = Promise.resolve();
const enqueue = (fn) => {
  const job = queue.then(fn);
  queue = job.catch(() => {});
  return job;
};

/** Open a session in the Claude window by clicking it in the sidebar (no mouse movement). */
export function switchSession(title) {
  const clean = String(title || '').trim().slice(0, 300);
  if (!clean) return Promise.resolve({ ok: false, error: 'empty_title' });
  return enqueue(() => runPs('switch', ['-TitleB64', b64(clean)]));
}

/**
 * Start a brand-new session: press Claude's own "New" button in the sidebar (or "New session in
 * <folder>" when `project` names one), and confirm an empty new-session prompt box appeared.
 * Nothing is typed or sent; Claude creates the session when its first message is sent.
 */
export function newSession({ project = '' } = {}) {
  const clean = String(project || '').trim().slice(0, 200);
  return enqueue(() => runPs('new', clean ? ['-ProjectB64', b64(clean)] : []));
}

/**
 * Put `text` into the open session's prompt box and press Claude's Send button.
 * `expectTitle`: refuse unless that session is the one open right now.
 * `expectNew`: refuse unless a new, not yet started session is open (it has no title yet), in
 * folder `expectFolder` when given. `filled`: fillDesktop already typed it in; send only if the
 * box still holds exactly it.
 */
export function sendToDesktop(text, { dryRun = false, expectTitle = null, expectNew = false, expectFolder = null, filled = false } = {}) {
  return promptBox(text, { expectTitle, expectNew, expectFolder, extra: [...(filled ? ['-Filled'] : []), ...(dryRun || process.env.ORBIT_DRY_RUN_SENDS === '1' ? ['-DryRun'] : [])] });
}

/**
 * Type a draft into the target session's prompt box without sending it, so the user can read it
 * there. `replace`: Orbit's earlier draft, which may be overwritten (anything else in the box is
 * left alone and the fill is refused). Sending it later: sendToDesktop with `filled`.
 */
export function fillDesktop(text, { expectTitle = null, expectNew = false, expectFolder = null, replace = null } = {}) {
  return promptBox(text, { expectTitle, expectNew, expectFolder, extra: ['-Fill', ...(replace ? ['-PrevB64', b64(String(replace).trim())] : [])] });
}

/** Empty the prompt box only if it still holds exactly `text` (Orbit's draft): never the user's typing. */
export function clearDesktop(text, { expectTitle = null, expectNew = false, expectFolder = null } = {}) {
  return promptBox(text, { expectTitle, expectNew, expectFolder, extra: ['-Clear'] });
}

// ORBIT_DRY_RUN_SENDS=1 (for testing) fills and clears the box instead of sending.
function promptBox(text, { expectTitle, expectNew, expectFolder, extra }) {
  const clean = String(text || '').trim();
  if (!clean) return Promise.resolve({ ok: false, error: 'empty_text' });
  if (clean.length > MAX_PROMPT_CHARS) return Promise.resolve({ ok: false, error: 'too_long', message: `Prompt is over ${MAX_PROMPT_CHARS} characters.` });
  const args = ['-TextB64', b64(clean), ...extra];
  if (expectTitle) args.push('-ExpectTitleB64', b64(expectTitle));
  else if (expectNew) {
    args.push('-ExpectNew');
    if (expectFolder) args.push('-ExpectFolderB64', b64(expectFolder));
  }
  return enqueue(() => runPs('send', args, expectNew ? 30000 : 20000));
}
