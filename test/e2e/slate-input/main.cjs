// A Discord-like test chat app of our own (Electron): a Slate.js message box (Enter sends) and a
// React search box, see editor.jsx. Shown without being activated; reports the page's own state
// (Slate's model, what was sent) on stdout as JSON lines, so tests can tell whether input really
// registered with the app. Like Discord it holds a single-instance lock: a second start hands over
// to the first one and quits.
// --splash=MS: like Discord, a small "<title> Updater" window shows first for MS ms, then the main
// window (a restart under Orbit keeps the flag, so its retry must wait past the splash).
//   electron [--remote-debugging-pipe | --remote-debugging-port=N] test/e2e/slate-input/main.cjs [title] [--user-data-dir=...] [--splash=MS]
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
  const splashMs = Number((process.argv.find((a) => a.startsWith('--splash=')) || '').split('=')[1]) || 0;
  let splashing = false; // (closing the splash before the main window exists must not quit the app)
  app.whenReady().then(async () => {
    if (splashMs > 0) {
      // The splash: small, titled like an updater, shown without being activated, then gone.
      const splash = new BrowserWindow({ width: 300, height: 340, x: Number(process.env.SLATE_X || 60) + 40, y: Number(process.env.SLATE_Y || 60) + 40, show: false, title: `${title} Updater`, frame: false });
      splash.on('page-title-updated', (e) => e.preventDefault());
      splash.loadURL('data:text/html,<body style="background:%23202225;color:white;font:14px sans-serif">Checking for updates...</body>');
      splash.once('ready-to-show', () => splash.showInactive());
      out({ event: 'splash' });
      splashing = true;
      await new Promise((r) => setTimeout(r, splashMs));
      splash.destroy();
    }
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
    splashing = false;
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
  app.on('window-all-closed', () => !splashing && app.quit());
}
