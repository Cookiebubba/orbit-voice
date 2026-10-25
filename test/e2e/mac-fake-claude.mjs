// A stand-in Claude app for Orbit's macOS tests: one window titled "Claude" showing
// test/e2e/mac-fake-claude.html (Claude's page structure). Run it, then start Orbit from source with
// ORBIT_TEST_CLAUDE_PID=<its pid> so Orbit's orb, Qubit and the Claude driver use this window and
// never the real Claude app:
//   electron test/e2e/mac-fake-claude.mjs [--move-after <s>]   (prints "fake-claude pid <n>")
// --move-after: the window moves by itself that many seconds in (and again twice), so a test can
// watch the orb and Qubit follow it.

import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
app.setName('Claude (test)');

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x: area.x + 80, y: area.y + 40, width: Math.min(1100, area.width - 160), height: Math.min(760, area.height - 80), title: 'Claude', webPreferences: { contextIsolation: true } });
  win.on('page-title-updated', (e) => e.preventDefault());
  await win.loadFile(path.join(HERE, 'mac-fake-claude.html'));
  console.log(`fake-claude pid ${process.pid}`);
  const after = Number(arg('--move-after'));
  if (after > 0) {
    const b = win.getBounds();
    const steps = [
      { x: b.x + 200, y: b.y + 60 },
      { x: b.x + 40, y: b.y + 20 },
      { x: b.x, y: b.y },
    ];
    steps.forEach((p, i) => setTimeout(() => win.setBounds({ ...b, ...p }), (after + i * 4) * 1000));
  }
});
app.on('window-all-closed', () => app.quit());
