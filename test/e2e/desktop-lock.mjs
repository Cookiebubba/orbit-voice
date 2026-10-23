// One test file at a time on the real desktop: the files that start real windows and run UI
// Automation against them (desktop-uia, focus-win, uia-win, ...) take this lock first, so
// `node --test` (which runs files in parallel) never has two of them competing for UI Automation
// or the foreground. The lock is a folder in the temp dir; one left by a dead process is taken over.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = path.join(os.tmpdir(), 'orbit-desktop-tests.lock');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Wait for the desktop (up to 10 minutes); released when this process exits. */
export async function lockDesktop() {
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      process.on('exit', () => {
        try {
          if (fs.readFileSync(path.join(LOCK, 'pid'), 'utf8') === String(process.pid)) fs.rmSync(LOCK, { recursive: true, force: true });
        } catch {}
      });
      return;
    } catch {
      let owner = 0;
      try {
        owner = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'));
      } catch {}
      // Taken over if its owner is gone (or never wrote its pid within a few seconds).
      const age = (() => {
        try {
          return Date.now() - fs.statSync(LOCK).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if ((owner && !alive(owner)) || (!owner && age > 5000)) fs.rmSync(LOCK, { recursive: true, force: true });
      if (Date.now() - t0 > 600_000) throw new Error('the desktop test lock was busy for 10 minutes');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
