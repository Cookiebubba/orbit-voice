// A test web app of our own (Electron): the page in page.html, shown without ever being activated,
// reporting its own state on stdout as JSON lines ({"state": {...}}), so tests can tell whether input
// really registered with the page (not just whether text appears in the box).
//   electron [--remote-debugging-port=N] test/e2e/web-input/main.cjs [title]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const title = process.argv.slice(2).find((a) => !a.startsWith('--') && !a.endsWith('main.cjs')) || 'ORBIT-WEB-INPUT';
app.commandLine.appendSwitch('force-renderer-accessibility'); // as screen readers and Orbit see web apps
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 560,
    height: 260,
    x: Number(process.env.WEB_INPUT_X || 40),
    y: Number(process.env.WEB_INPUT_Y || 40),
    show: false,
    title,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, contextIsolation: true },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  ipcMain.on('state', (_e, s) => out({ state: s }));
  win.on('focus', () => out({ event: 'activated' }));
  win.loadFile(path.join(__dirname, 'page.html'));
  win.once('ready-to-show', () => {
    win.showInactive(); // shown, never activated
    out({ ready: true, pid: process.pid, hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString() });
  });
  process.stdin.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.trim() === 'quit') app.quit();
    }
  });
});
app.on('window-all-closed', () => app.quit());
