// Writing to the clipboard. The desktop app plugs in Electron's clipboard; in browser mode we fall
// back to PowerShell's Set-Clipboard on Windows or /usr/bin/pbcopy on macOS, with the text passed on
// stdin (never as an argument, so nothing in it can be interpreted as a command).

import { execFile } from 'node:child_process';
import path from 'node:path';

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const MAX_CLIPBOARD_CHARS = 20000;

let writer = null;

/** The desktop shell provides a writer: (text) => void. */
export function setClipboardWriter(fn) {
  writer = fn;
}

export async function writeClipboard(text) {
  const value = String(text ?? '');
  if (!value) return { ok: false, error: 'Nothing to copy.' };
  if (value.length > MAX_CLIPBOARD_CHARS) return { ok: false, error: `That's over ${MAX_CLIPBOARD_CHARS} characters, too long to copy.` };
  if (writer) {
    writer(value);
    return { ok: true, chars: value.length };
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      const child = execFile('/usr/bin/pbcopy', [], { timeout: 10000, env: { ...process.env, LANG: 'en_US.UTF-8' } }, (err) =>
        resolve(err ? { ok: false, error: 'Could not write to the clipboard.' } : { ok: true, chars: value.length }),
      );
      child.stdin.end(value, 'utf8');
    });
  }
  if (process.platform !== 'win32') return { ok: false, error: 'Clipboard is only supported on Windows and macOS in browser mode.' };
  return new Promise((resolve) => {
    const child = execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      { timeout: 10000, windowsHide: true },
      (err) => resolve(err ? { ok: false, error: 'Could not write to the clipboard.' } : { ok: true, chars: value.length }),
    );
    child.stdin.end(value, 'utf8');
  });
}
