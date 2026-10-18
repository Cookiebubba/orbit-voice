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

function runPs(mode, args = [], timeoutMs = 20000) {
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
          result = { ok: false, error: 'script_failed', message: (stderr || err?.message || stdout || 'unknown error').toString().slice(0, 500) };
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

/** Which session is open in the Claude window, and is anything typed in its prompt box? */
export function getDesktopInfo() {
  return runPs('info');
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

/** Type `text` into the open session's prompt box and press Enter. */
export function sendToDesktop(text, { dryRun = false, returnFocus = true } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return Promise.resolve({ ok: false, error: 'empty_text' });
  if (clean.length > MAX_PROMPT_CHARS) return Promise.resolve({ ok: false, error: 'too_long', message: `Prompt is over ${MAX_PROMPT_CHARS} characters.` });
  const args = ['-TextB64', b64(clean)];
  if (dryRun) args.push('-DryRun');
  if (returnFocus) args.push('-ReturnFocus');
  return enqueue(() => runPs('send', args));
}
