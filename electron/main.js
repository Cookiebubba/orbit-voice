// Desktop shell: a small frameless main window, a floating always-on-top orb that replaces
// it while minimized, a tray icon, and the global hotkey. The bridge server runs in-process.
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, screen, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, getSetting, updateSettings } from '../src/config.js';
import { getLogDir, logError, logWarn } from '../src/log.js';
import { authUrl, hotkeyLabel, startServer } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRELOAD = path.join(HERE, 'preload.cjs');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png');
const ORB_SIZE = 128;
const START_HIDDEN = process.argv.includes('--background'); // used by "Start with Windows"

app.setName('Orbit');
// Developer testing only: feed a WAV file in as the microphone (never in the installed app).
if (!app.isPackaged && process.env.GVB_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.GVB_FAKE_MIC);
}
app.setAppUserModelId('dev.orbit.voice');
app.setPath('userData', path.join(app.getPath('appData'), 'Orbit'));

let main = null;
let orb = null;
let tray = null;
let agentsWin = null;
let baseUrl = '';
let drag = null; // { cursor, win } at drag start
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

/** The xAI key, encrypted with Windows DPAPI (tied to your Windows account). */
function encryptedKeyStore(dir) {
  const file = path.join(dir, 'xai-key.bin');
  return {
    kind: safeStorage.isEncryptionAvailable() ? 'windows-dpapi' : 'unavailable',
    get() {
      try {
        return safeStorage.decryptString(fs.readFileSync(file));
      } catch {
        return '';
      }
    },
    set(key) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is not available, so the key was not saved.');
      fs.writeFileSync(file, safeStorage.encryptString(key));
    },
  };
}

const secureWebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: false,
  backgroundThrottling: false, // keep listening while hidden
};

/** Keep every window on our own local page. */
function lockDown(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseUrl)) e.preventDefault();
  });
}

function createMain() {
  main = new BrowserWindow({
    width: 360,
    height: 580,
    minWidth: 320,
    minHeight: 480,
    frame: false,
    backgroundColor: '#000000',
    title: 'Orbit',
    icon: ICON,
    show: false,
    webPreferences: secureWebPreferences,
  });
  lockDown(main);
  main.loadURL(authUrl('main')); // signs the window in, then shows the UI
  main.once('ready-to-show', () => (START_HIDDEN ? showOrb() : main.show()));
  // Any way of minimizing (our button, taskbar click, Win+Down) turns into the orb.
  main.on('minimize', () => showOrb());
  main.on('close', () => {
    quitting = true;
  });
  main.on('closed', () => app.quit());
}

function orbStartPosition() {
  const saved = getSetting('orbPosition');
  const displays = screen.getAllDisplays();
  if (saved && displays.some((d) => saved[0] >= d.workArea.x - 20 && saved[1] >= d.workArea.y - 20 && saved[0] < d.workArea.x + d.workArea.width && saved[1] < d.workArea.y + d.workArea.height)) {
    return saved;
  }
  const { workArea } = screen.getPrimaryDisplay();
  return [workArea.x + workArea.width - ORB_SIZE - 24, workArea.y + workArea.height - ORB_SIZE - 24];
}

function createOrb() {
  orb = new BrowserWindow({
    width: ORB_SIZE,
    height: ORB_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Orbit orb',
    webPreferences: secureWebPreferences,
  });
  lockDown(orb);
  orb.setAlwaysOnTop(true, 'screen-saver');
  orb.setPosition(...orbStartPosition());
  orb.loadURL(authUrl('orb'));
}

function showOrb() {
  main.hide();
  orb.showInactive();
}

function showMain() {
  if (!main) return;
  orb?.hide();
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

// The Agents window: read-only cards for Orbit Agents runs. Opens on demand; closing it just closes it.
function showAgents() {
  if (agentsWin) {
    if (agentsWin.isMinimized()) agentsWin.restore();
    return agentsWin.focus();
  }
  agentsWin = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 420,
    backgroundColor: '#000000',
    title: 'Orbit Agents',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: 40 },
    show: false,
    webPreferences: secureWebPreferences,
  });
  lockDown(agentsWin);
  agentsWin.loadURL(authUrl('agents'));
  agentsWin.once('ready-to-show', () => agentsWin.show());
  agentsWin.on('closed', () => (agentsWin = null));
}

// ---------- tray ----------
const loginEnabled = () => app.getLoginItemSettings({ args: ['--background'] }).openAtLogin;
function setLogin(enabled) {
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--background'] });
  refreshTray();
  return loginEnabled();
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`Orbit: ${hotkeyLabel(getSetting('wakeHotkey'))} to talk`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Orbit', click: showMain },
      { label: `Talk / sleep  (${hotkeyLabel(getSetting('wakeHotkey'))})`, click: () => main?.webContents.send('hotkey') },
      { label: 'Agents', click: showAgents },
      { type: 'separator' },
      { label: 'Start with Windows', type: 'checkbox', checked: loginEnabled(), click: (item) => setLogin(item.checked) },
      { type: 'separator' },
      { label: 'Quit Orbit', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.on('click', showMain);
  refreshTray();
}

// ---------- global hotkey ----------
// Works from any app: starts Grok if it's off, otherwise puts it to sleep / wakes it.
let activeHotkey = null; // the accelerator we currently hold, or null
let hotkeyHits = 0; // how many times it fired (used by the self-test)

function registerHotkey(accel) {
  try {
    return (
      globalShortcut.isRegistered(accel) ||
      globalShortcut.register(accel, () => {
        hotkeyHits++;
        main?.webContents.send('hotkey');
      })
    );
  } catch {
    return false; // not a valid accelerator
  }
}

const hotkeyInfo = (extra = {}) => ({
  accelerator: getSetting('wakeHotkey'),
  label: hotkeyLabel(getSetting('wakeHotkey')),
  registered: !!activeHotkey,
  defaultAccelerator: DEFAULTS.wakeHotkey,
  ...extra,
});

// Only our own pages may use these channels.
const fromUs = (e) => !!baseUrl && e.senderFrame?.url?.startsWith(baseUrl);
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => (fromUs(e) ? fn(...args) : undefined));
const on = (channel, fn) => ipcMain.on(channel, (e, ...args) => fromUs(e) && fn(...args));

handle('hotkey:get', () => hotkeyInfo());
handle('hotkey:set', (accel) => {
  if (typeof accel !== 'string' || !/^[\w+.-]{1,60}$/.test(accel)) return hotkeyInfo({ ok: false, error: 'No shortcut given.' });
  if (activeHotkey && activeHotkey !== accel) globalShortcut.unregister(activeHotkey);
  if (!registerHotkey(accel)) {
    if (activeHotkey) registerHotkey(activeHotkey); // put the old one back
    return hotkeyInfo({ ok: false, error: 'Windows or another app is already using that shortcut. Try a different one.' });
  }
  activeHotkey = accel;
  updateSettings({ wakeHotkey: accel });
  refreshTray();
  return hotkeyInfo({ ok: true });
});
// While the settings screen records a new shortcut, let key presses reach it.
handle('hotkey:suspend', (suspended) => {
  if (!activeHotkey) return;
  if (suspended) globalShortcut.unregister(activeHotkey);
  else registerHotkey(activeHotkey);
});
handle('app:get-login', () => loginEnabled());
handle('app:set-login', (enabled) => setLogin(enabled));
handle('app:open-logs', () => getLogDir() && shell.openPath(getLogDir()));

on('win:minimize', () => showOrb());
on('agents:open', () => showAgents());
on('win:close', () => app.quit());
on('orb:restore', () => showMain());
on('orb:state', (s) => orb?.webContents.send('orb:state', s));
on('orb:action', (a) => main?.webContents.send('orb:action', a));
on('orb:drag-start', () => {
  drag = { cursor: screen.getCursorScreenPoint(), win: orb.getPosition() };
});
on('orb:drag-move', () => {
  if (!drag) return;
  const c = screen.getCursorScreenPoint();
  orb.setPosition(drag.win[0] + c.x - drag.cursor.x, drag.win[1] + c.y - drag.cursor.y);
});
on('orb:drag-end', () => {
  drag = null;
  updateSettings({ orbPosition: orb.getPosition() });
});

app.whenReady().then(async () => {
  if (quitting) return;
  try {
    const dir = app.getPath('userData');
    baseUrl = await startServer({
      configDir: dir,
      secrets: encryptedKeyStore(dir),
      clipboard: (text) => clipboard.writeText(text),
      // Offline wake-word model: shipped next to the app (extraResources), or in the repo in dev.
      models: app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(ROOT, 'resources', 'models'),
    });
  } catch (e) {
    logError('app', 'Bridge failed to start', e?.message);
    dialog.showErrorBox(
      'Orbit',
      e.code === 'EADDRINUSE' ? 'Port 4317 is already in use, probably by another copy of Orbit. Close it first.' : String(e.message || e),
    );
    return app.quit();
  }
  // Microphone and notifications only, and only for our own page.
  const ALLOWED_PERMISSIONS = new Set(['media', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission) && wc.getURL().startsWith(baseUrl)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ALLOWED_PERMISSIONS.has(permission) && !!wc && wc.getURL().startsWith(baseUrl));
  app.on('web-contents-created', (_e, wc) => wc.on('will-attach-webview', (ev) => ev.preventDefault()));

  createMain();
  createOrb();
  createTray();
  if (registerHotkey(getSetting('wakeHotkey'))) activeHotkey = getSetting('wakeHotkey');
  else logWarn('hotkey', `Could not register ${getSetting('wakeHotkey')}; another app may be using it`);

  if (process.env.GVB_SNAPSHOT_DIR && !app.isPackaged) {
    const { runSelfTest } = await import('./selftest.js');
    runSelfTest({ dir: process.env.GVB_SNAPSHOT_DIR, main, orb, globalShortcut, hits: () => hotkeyHits, showOrb }).finally(() => app.quit());
  }
});

app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
