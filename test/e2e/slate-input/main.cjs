// A Discord-like test chat app of our own (Electron): a Slate.js message box (Enter sends) and a
// React search box, see editor.jsx. Shown without being activated; reports the page's own state
// (Slate's model, what was sent) on stdout as JSON lines, so tests can tell whether input really
// registered with the app. Like Discord it holds a single-instance lock: a second start hands over
// to the first one and quits.
//   electron [--remote-debugging-pipe | --remote-debugging-port=N] test/e2e/slate-input/main.cjs [title] [--user-data-dir=...]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const title = process.argv.slice(2).find((a) => !a.startsWith('--') && !a.endsWith('main.cjs')) || 'ORBIT-SLATE-CHAT';
app.commandLine.appendSwitch('force-renderer-accessibility');
const out = (o) => {
  try {
    process.stdout.write(`${JSON.stringify(o)}\n`);
  } catch {}
};

if (!app.requestSingleInstanceLock()) {
  out({ secondInstance: true });
  app.quit();
} else {
  app.on('second-instance', () => out({ event: 'second-instance' }));
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: Number(process.env.SLATE_W || 760),
      height: Number(process.env.SLATE_H || 420),
      x: Number(process.env.SLATE_X || 60),
      y: Number(process.env.SLATE_Y || 60),
      show: false,
      title,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, contextIsolation: true },
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    ipcMain.on('state', (_e, s) => out({ state: s }));
    win.on('focus', () => out({ event: 'activated' }));
    win.loadFile(path.join(__dirname, 'page.html'));
    win.once('ready-to-show', () => {
      win.showInactive();
      if (process.env.SLATE_TOP === '1') win.setAlwaysOnTop(true); // (a test that needs it in front of everything)
      out({ ready: true, pid: process.pid, hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(), pipe: app.commandLine.hasSwitch('remote-debugging-pipe') });
    });
    process.stdin.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.trim() === 'quit') app.quit();
    });
    process.stdin.on('error', () => {});
  });
  app.on('window-all-closed', () => app.quit());
}
