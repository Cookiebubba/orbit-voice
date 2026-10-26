// Desktop shell: a small frameless main window, a floating always-on-top orb that replaces
// it while minimized, a tray icon, and the global hotkey. The bridge server runs in-process.
//
// macOS: the same app. Orbit's Swift helper (native/mac/OrbitHelper, see src/platform/mac/) stands in
// for the PowerShell helpers: it drives the Claude window through the accessibility API, follows its
// windows for the orb and Qubit, and reads and acts in other apps. Without it (or without the
// Accessibility permission) the orb floats free and Qubit lives along the bottom of the screen. The
// main window has the traffic lights, the tray icon is a menu-bar template image, and macOS's privacy
// permissions (Microphone, Accessibility, Screen Recording) are asked for at sensible moments and
// shown in Settings (see "macOS permissions" below).
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, screen, session, shell, systemPreferences, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, getSetting, onSettingsChange, updateSettings } from '../src/config.js';
import { createClaudeWindowTracker } from './claude-window.js';
import { helperRectToDip } from './buddy-geometry.js';
import { DEFAULT_ANCHOR, anchorFor, isAnchor, orbPositionFor } from './orb-stick.js';
import { getDesktopInfo, onPromptBoxWork, setDesktopDriver, setDesktopTestPid, setFrontWindowHint } from '../src/desktop.js';
import { hasHelper as hasMacHelper, runHelperOnce } from '../src/platform/mac/helper.js';
import { getLogDir, logError, logInfo, logWarn } from '../src/log.js';
import { authUrl, hotkeyLabel, startServer, stopBackgroundWork } from '../src/server.js';
import { createUpdater } from './updater.js';
import { createAvatar } from './avatar.js';
import { createAvatarHost } from './avatar-host.js';
import { createOrbitMouse } from './orbit-mouse.js';
import { hideMouse, setMouseSink } from '../src/anywhere/mouse.js';
import { contexts as anywhereContexts, wakeWith } from '../src/anywhere/index.js';
import { setMcpShell } from '../src/mcp/index.js';
import { setKeeperCrypto, setKeeperLauncher } from '../src/anywhere/keeper.js';
import { setAvatarSink } from '../src/avatar-commands.js';
import { focus, startFocusTracking, startUia, stopUia } from '../src/platform/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRELOAD = path.join(HERE, 'preload.cjs');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const IS_MAC = process.platform === 'darwin';
// macOS menu bar: a black-and-alpha template image (trayTemplate.png + @2x), tinted by the system.
const TRAY_ICON = path.join(ROOT, 'assets', IS_MAC ? 'trayTemplate.png' : 'tray.png');
const ORB_SIZE = 128;
const START_HIDDEN = process.argv.includes('--background'); // used by "Start with Windows" (macOS: see startHidden)
const LOGIN_LABEL = IS_MAC ? 'Open at login' : 'Start with Windows';
/** Started quietly (as the orb): "--background" on Windows; opened as a login item on macOS. */
function startHidden() {
  if (START_HIDDEN || !IS_MAC) return START_HIDDEN;
  try {
    return !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}
/** Floating windows follow you across Spaces on macOS (no-op elsewhere). The dock icon stays:
 *  skipTransformProcessType keeps Orbit a normal app (without it Electron hides the dock icon to let
 *  the window float over other apps' full-screen Spaces). */
function followSpaces(win) {
  if (!IS_MAC || !win || win.isDestroyed()) return;
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch { /* older Electron */ }
}

app.setName('Orbit');
// Developer testing only: feed a WAV file in as the microphone (never in the installed app).
if (!app.isPackaged && process.env.GVB_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.GVB_FAKE_MIC);
}
if (process.platform === 'win32') app.setAppUserModelId('dev.orbit.voice'); // Windows taskbar and notifications only
app.setPath('userData', path.join(app.getPath('appData'), 'Orbit'));
// Developer testing only (never in the installed app): a settings folder of its own, so a test run
// never touches your real Orbit settings, keys or logs.
if (!app.isPackaged && process.env.ORBIT_USER_DATA) app.setPath('userData', path.resolve(process.env.ORBIT_USER_DATA));

let main = null;
let orb = null;
let avatar = null; // the avatar along the bottom of the Claude window: the pixel buddy or Qubit (see avatar.js)
let lastOrbState = null; // Orbit's voice state, for an avatar that turns up later
let tray = null;
let baseUrl = '';
/** Is this URL Orbit's own page? An exact origin match: a prefix test would also accept
 *  127.0.0.1:43170 or 127.0.0.1:4317@elsewhere. */
function isOurs(url) {
  if (!baseUrl || !url) return false;
  try {
    const u = new URL(url);
    return u.origin === new URL(baseUrl).origin && !u.username && !u.password;
  } catch {
    return false;
  }
}
let drag = null; // { cursor, win } at drag start
let quitting = false;

// Developer testing only (the parity suite, parity/PROTOCOL.md): a throwaway profile folder for
// settings, keys (in a plain .env there, never the Keychain or DPAPI), logs and caches, so the user's
// own profile is never touched. The single-instance lock lives in it too.
const PROFILE = !app.isPackaged && process.env.ORBIT_PROFILE_DIR ? path.resolve(process.env.ORBIT_PROFILE_DIR) : null;
if (PROFILE) app.setPath('userData', PROFILE);
if (PROFILE && IS_MAC) app.commandLine.appendSwitch('use-mock-keychain');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}
// Developer testing only (never in the installed app): the parity suite's driver (electron/parity-driver.js).
if (!app.isPackaged && process.env.ORBIT_PARITY_PORT) {
  const { startParityDriver } = await import('./parity-driver.js');
  startParityDriver({ main: () => main, orb: () => orb, avatar: () => avatar, avatarHost: () => avatarHost, claude: () => claude, orbitMouse: () => orbitMouse, showMain: () => showMain(), showOrb: () => showOrb() });
}

/**
 * A key (xAI, or the optional Anthropic one), encrypted with the system's own store: Windows DPAPI
 * (tied to your Windows account) or, on macOS, a key kept in your login Keychain. If macOS asks
 * whether Orbit may use the Keychain and you deny it, the key isn't saved (and a saved one reads as
 * missing), with a plain message instead of a crash.
 */
function encryptedKeyStore(dir, name = 'xai-key.bin') {
  const file = path.join(dir, name);
  const system = IS_MAC ? 'macOS Keychain' : 'Windows encryption';
  const available = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    kind: available() ? (IS_MAC ? 'macos-keychain' : 'windows-dpapi') : 'unavailable',
    get() {
      try {
        return safeStorage.decryptString(fs.readFileSync(file));
      } catch {
        return '';
      }
    },
    set(key) {
      if (!available()) throw new Error(`${system} is not available, so the key was not saved.`);
      let sealed;
      try {
        sealed = safeStorage.encryptString(key);
      } catch {
        throw new Error(IS_MAC ? 'Orbit could not use your macOS Keychain (access may have been denied), so the key was not saved. Try again and choose Allow.' : 'Windows encryption failed, so the key was not saved.');
      }
      fs.writeFileSync(file, sealed);
    },
  };
}

/**
 * Connectors' sign-in tokens (Orbit anywhere, src/mcp/oauth.js): one encrypted file of key -> value,
 * sealed like the xAI key (Windows DPAPI / macOS Keychain). Without the system's encryption they're
 * kept in memory only (until Orbit quits).
 */
function encryptedMapStore(dir, name) {
  const file = path.join(dir, name);
  let memory = null;
  const available = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  const load = () => {
    if (memory) return memory;
    try {
      memory = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    } catch {
      memory = {};
    }
    return memory;
  };
  return {
    get: (k) => (typeof load()[k] === 'string' ? load()[k] : null),
    set(k, v) {
      const m = load();
      if (v) m[k] = String(v);
      else delete m[k];
      if (available()) fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(m)));
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
    if (!isOurs(url)) e.preventDefault();
  });
}

function createMain() {
  main = new BrowserWindow({
    width: 360,
    height: 580,
    minWidth: 320,
    minHeight: 480,
    // Windows: no frame (the page draws its own title bar). macOS: the page's bar with the system's
    // traffic lights on it (close quits, minimize turns into the orb, as the page's buttons do there).
    ...(IS_MAC ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 }, fullscreenable: false } : { frame: false }),
    backgroundColor: '#ffffff', // the page is white (the website's look): no dark flash while it loads
    title: 'Orbit',
    icon: ICON,
    show: false,
    webPreferences: secureWebPreferences,
  });
  lockDown(main);
  main.loadURL(authUrl('main')); // signs the window in, then shows the UI
  main.once('ready-to-show', () => (startHidden() ? showOrb() : main.show()));
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
  followSpaces(orb);
  orbLayer = 'free';
  orb.setPosition(...orbStartPosition());
  orb.loadURL(authUrl('orb'));
}

function showOrb() {
  main.hide();
  orbMode = true;
  drag = null; // a click on the orb starts a "drag" that never ends; don't let it block the orb
  if (!orbAllowed()) return orb.hide(); // the avatar stands in for it (open Orbit from the tray)
  if (getSetting('orbStick') && claude?.found) placeOrb();
  else orb.showInactive();
}

function showMain() {
  if (!main) return;
  orbMode = false;
  drag = null;
  claudeTracker.pause();
  orb?.hide();
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

// ---------- stick to Claude Code ----------
// The orb rides on the Claude window: it follows moves and resizes at any display scaling, sits
// just above Claude in z-order (topmost only while Claude or Orbit is in front, so other apps can
// cover both), hides while Claude is minimized, and floats freely again when Claude isn't on
// screen (closed, or on another virtual desktop). Dragging it picks a new spot on the window.
let orbMode = false; // the orb is meant to be showing (the main window is hidden)
let orbLayer = null; // 'free' | 'top' | 'above:<hwnd>'
let claude = null; // the Claude window the orb docks on (the one you were in last): { found, hwnd, min, front, x, y, w, h } in screen pixels
let claudeDip = null; // the Claude window in DIPs, when sticking
let fakeWindowHelper = null; // developer testing only: a stand-in for claude-window.ps1 (see below)
// Developer testing only (never in the installed app): on macOS, a stand-in Claude window's process
// (scripts/mac-e2e.mjs) for the window tracker and the Claude desktop driver.
const testClaudePid = () => (!app.isPackaged && Number(process.env.ORBIT_TEST_CLAUDE_PID)) || 0;
if (testClaudePid()) setDesktopTestPid(testClaudePid());
const claudeTracker = createClaudeWindowTracker({
  spawnHelper: () => fakeWindowHelper?.() || null,
  testPid: testClaudePid,
  onChange: (s) => {
    claude = s;
    anywhereContexts.setHomeWindow(s?.found ? s.hwnd : 0); // the Claude window is Orbit's home context
    placeOrb();
    avatar?.onClaude(s);
    avatarHost.onFocus(); // (a window's Qubit never stands on the window home is on)
    watchBox();
  },
  // Where Claude's prompt box is, the moment it moves (the avatar stands on it).
  onBox: (b) => avatar?.onBoxRect(b),
  onError: (message) => logWarn('orb', message),
});
/** The helper watches the prompt box of the window the avatar is on, only while it shows. */
const watchBox = () => claudeTracker.watchBox(avatar?.boxWindow || 0);
// Orbit typing a draft in, clearing it or sending: the box grows or shrinks right then.
onPromptBoxWork(() => claudeTracker.burst());
const sticking = () => getSetting('orbStick') && !!claude?.found;
// Grok's tools act on the same Claude window the orb is on (see src/desktop.ps1 -FrontHwnd).
setFrontWindowHint(() => (claudeTracker.running && claude?.found ? claude.hwnd : 0));

function setOrbBounds({ x, y }) {
  const b = orb.getBounds();
  // Always pass the size too: moving between displays with different scaling can otherwise
  // leave the window resized.
  if (b.x !== x || b.y !== y || b.width !== ORB_SIZE || b.height !== ORB_SIZE) orb.setBounds({ x, y, width: ORB_SIZE, height: ORB_SIZE });
}

function setOrbLayer(layer) {
  if (layer === orbLayer) return;
  orbLayer = layer;
  if (layer === 'free' || layer === 'top') return orb.setAlwaysOnTop(true, 'screen-saver');
  orb.setAlwaysOnTop(false);
  try {
    orb.moveAbove(`window:${claude.hwnd}:0`); // directly above Claude, under whatever covers it
  } catch {
    orb.setAlwaysOnTop(true, 'screen-saver');
  }
}

function placeOrb() {
  if (!orb || orb.isDestroyed() || drag) return;
  if (!orbAllowed()) {
    claudeTracker.pause();
    orb.hide();
    return;
  }
  if (!sticking()) {
    claudeTracker.pause();
    claudeDip = null;
    if (orbLayer !== 'free') {
      setOrbLayer('free');
      const [x, y] = orbStartPosition();
      setOrbBounds({ x, y });
    }
    if (orbMode && !orb.isVisible()) {
      orb.showInactive();
      orb.setAlwaysOnTop(true, 'screen-saver');
    }
    return;
  }
  claudeDip = helperRectToDip(screen, claude);
  if (claude.min || !orbMode) {
    claudeTracker.pause();
    if (orb.isVisible()) orb.hide();
    return;
  }
  const anchor = isAnchor(getSetting('orbStickAnchor')) ? getSetting('orbStickAnchor') : DEFAULT_ANCHOR;
  if (!orb.isVisible()) {
    setOrbBounds(orbPositionFor(claudeDip, anchor, ORB_SIZE)); // in place before it appears
    orb.showInactive();
    orbLayer = null; // z-order set while hidden may not stick: apply it again now that it shows
  }
  // From here the helper moves the orb itself the instant Claude moves (no trailing behind). On macOS
  // Orbit moves it, on each report (the helper looks often while Claude's window moves).
  if (!claudeTracker.movesOrb) setOrbBounds(orbPositionFor(claudeDip, anchor, ORB_SIZE));
  claudeTracker.follow(nativeHandle(orb), anchor);
  setOrbLayer(claude.front === 'other' ? `above:${claude.hwnd}` : 'top');
}

/** A window's HWND as a decimal string (for the helper). */
function nativeHandle(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
}

// ---------- the avatar ----------
// Settings -> Avatar: the pixel buddy, Qubit or none. Switching is live: the new one's window comes
// up with an entrance while the old one fades out (see avatar.js).
const avatarKind = () => (['buddy', 'qubit'].includes(getSetting('avatar')) ? getSetting('avatar') : null);
// Settings -> Avatar -> Show the orb: with an avatar on, the orb can be turned off (the avatar stands
// in for it). Without an avatar the orb always shows, so there is always something on screen.
const orbAllowed = () => getSetting('showOrb') !== false || !avatarKind();
// Settings -> Avatar: click it to talk, and pick it up to throw it (its page reads these).
const avatarPrefs = () => ({ clickTalk: getSetting('avatarClickTalk') !== false, throw: getSetting('avatarThrow') !== false, throwSound: getSetting('avatarThrowSound') !== false });
function setAvatar({ live = false } = {}) {
  const kind = avatarKind();
  const size = getSetting('buddySize');
  if (avatar && avatar.kind === kind) {
    avatarHost.setKind(kind && !freeAvatar() ? kind : null, size);
    return avatar.setEnabled(true, size);
  }
  const old = avatar;
  avatar = null;
  // One avatar per place, at every moment: the old one fades out and its window closes first, and
  // only then does the new one come up (with its entrance). Never two on the Claude window at once.
  const gone = old ? old.leave() : Promise.resolve();
  if (kind) {
    const next = createAvatar({
      kind,
      url: () => authUrl(kind),
      webPreferences: secureWebPreferences,
      lockDown,
      getDesktopInfo,
      log: (m) => logWarn('avatar', m),
      info: (m) => logInfo('avatar', m),
      // No Claude window to live on (no window helper): along the bottom of the screen instead.
      free: freeAvatar(),
      onWindow: followSpaces,
      prefs: avatarPrefs,
    });
    avatar = next;
    if (lastOrbState) avatarHost.onVoice(lastOrbState); // (home gets it, or rests while the talk is elsewhere)
    if (claude) next.onClaude(claude);
    const up = () => avatar === next && next.setEnabled(true, getSetting('buddySize'), { entrance: live });
    if (old) gone.then(up);
    else up();
  }
  // The Qubits in other windows (Orbit anywhere) become the same avatar, or go.
  avatarHost.setKind(kind && !freeAvatar() ? kind : null, size);
  avatarHost.setEnabled(!!kind && !freeAvatar());
  watchBox();
}

/**
 * The avatar floats free when there's no Claude window tracker on this platform (only Windows has
 * one). ORBIT_FREE_AVATAR=1 forces it from source (developer testing: scripts/avatar-free-e2e.mjs).
 */
const freeAvatar = () => (process.platform !== 'win32' && !fakeWindowHelper && !(IS_MAC && hasMacHelper())) || (!app.isPackaged && process.env.ORBIT_FREE_AVATAR === '1');

// What the user asks the avatar to do (the voice model's `avatar` tool and the fast path that skips
// the model) goes to its window.
setAvatarSink((cmd) => {
  const a = avatarHost.active();
  return a ? a.command(cmd) : { ok: false, error: 'There is no avatar on screen.' };
});

// ---------- Orbit anywhere: a Qubit in every window Orbit is in ----------
// The home avatar above lives on the Claude window; avatar-host.js hosts one more per window the
// conversation has been in (src/anywhere/contexts.js), each on that window's bottom edge.
const avatarHost = createAvatarHost({
  makeAvatar: (kind) =>
    createAvatar({
      kind,
      url: () => authUrl(kind),
      webPreferences: secureWebPreferences,
      lockDown,
      getDesktopInfo,
      log: (m) => logWarn('avatar', m),
      info: (m) => logInfo('avatar', m),
      boxless: true,
      onWindow: followSpaces,
      prefs: avatarPrefs,
    }),
  home: () => avatar,
  watch: (hwnds) => focusTracker?.watch(hwnds),
  current: () => focus.current,
  log: (m) => logInfo('avatar', m),
});
anywhereContexts.on((snap) => avatarHost.sync(snap));
focus.on('change', () => avatarHost.onFocus());

// The Claude window watcher runs while the orb sticks to Claude or an avatar is on.
// (A free-floating avatar doesn't need it.)
const needTracker = () => !!getSetting('orbStick') || (!!avatarKind() && !freeAvatar());
onSettingsChange((changed) => {
  if (changed.includes('avatarClickTalk') || changed.includes('avatarThrow') || changed.includes('avatarThrowSound')) {
    avatar?.refresh();
    avatarHost.refresh();
  }
  if (changed.includes('avatar') || changed.includes('buddySize')) setAvatar({ live: true });
  if (changed.includes('showOrb') && !changed.includes('orbStick') && !changed.includes('avatar')) return placeOrb();
  if (!changed.includes('orbStick') && !changed.includes('avatar')) return;
  if (needTracker()) {
    claudeTracker.start();
    if (claude) avatar?.onClaude(claude);
  } else {
    claudeTracker.stop();
    claude = null;
    avatar?.onClaude({ found: false });
  }
  placeOrb();
});

// ---------- Orbit anywhere: Orbit's mouse ----------
// A second, visual cursor of Orbit's own (electron/orbit-mouse.js: a click-through overlay per
// display): it points at controls ("show me where") and glides to each one Orbit acts on, first.
// Settings -> Orbit anywhere -> Show Orbit's mouse. The user's own mouse is never moved.
const mouseWanted = () => getSetting('anywhere') !== false && getSetting('anywhereMouse') !== false;
const orbitMouse = createOrbitMouse({
  url: () => authUrl('mouse'),
  webPreferences: secureWebPreferences,
  lockDown,
  enabled: mouseWanted,
  log: (m) => logInfo('mouse', m),
});
setMouseSink(orbitMouse);
let mouseWarm = false;
onSettingsChange((changed) => {
  if ((changed.includes('anywhereMouse') || changed.includes('anywhere')) && !mouseWanted()) hideMouse();
});

// ---------- Orbit anywhere: the window you're in ----------
// Follows the window in front in any app (src/platform/win/focus.ps1: window events, no polling),
// while Settings -> Orbit anywhere is on. Tools read "this window" from it.
let focusTracker = null;
let fakeFocusHelper = null; // developer testing only: a stand-in for focus.ps1 (see ORBIT_FAKE_DESKTOP)
let fakeDesktop = false; // developer testing only: never start the real helpers then
let fakeUiaHelper = null; // developer testing only: a stand-in for uia.ps1
function setFocusTracking() {
  const want = getSetting('anywhere') !== false && (!fakeDesktop || !!fakeFocusHelper);
  if (want && !focusTracker) {
    focusTracker = startFocusTracking({ spawnHelper: fakeFocusHelper, onError: (m) => logWarn('focus', m), onWins: (wins) => avatarHost.onWins(wins) });
    // Reading other apps' windows (UI Automation): its helper starts on the first read.
    if (!fakeDesktop || fakeUiaHelper) startUia({ spawnHelper: fakeUiaHelper, cacheDir: path.join(app.getPath('userData'), 'cache'), onError: (m) => logWarn('uia', m) });
  } else if (!want && focusTracker) {
    focusTracker.stop();
    focusTracker = null;
    stopUia();
  }
}
onSettingsChange((changed) => changed.includes('anywhere') && setFocusTracking());

// ---------- updates (GitHub Releases) ----------
let updater = null; // created when the app is ready (the settings are loaded then)
onSettingsChange((changed) => {
  if (changed.includes('autoUpdate')) updater?.setAuto(!!getSetting('autoUpdate'));
});

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
      { type: 'separator' },
      { label: LOGIN_LABEL, type: 'checkbox', checked: loginEnabled(), click: (item) => setLogin(item.checked) },
      { type: 'separator' },
      { label: 'Quit Orbit', click: () => app.quit() },
    ]),
  );
}

/**
 * macOS: the menu bar's app menu (About, Settings… ⌘,, Hide, Quit ⌘Q), Edit (so ⌘C / ⌘V work in
 * Orbit's own fields) and Window. No View menu: reload and the developer tools stay out of the
 * installed app. (Windows has no app menu: the page draws its own title bar.)
 */
function createAppMenu() {
  if (!IS_MAC) return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Orbit',
        submenu: [
          { role: 'about', label: 'About Orbit' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Command+,', click: () => (showMain(), main?.webContents.send('app:settings')) },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: 'Hide Orbit' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit Orbit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
      ...(app.isPackaged ? [] : [{ role: 'viewMenu' }]),
    ]),
  );
}

function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICON);
  if (IS_MAC) image.setTemplateImage(true); // (the name says so too; this makes sure)
  tray = new Tray(image);
  // macOS opens the menu on click (it has "Open Orbit"); Windows opens Orbit.
  if (!IS_MAC) tray.on('click', showMain);
  refreshTray();
}

// ---------- microphone (macOS privacy) ----------
// macOS asks once whether Orbit may use the microphone. Ask before the page first opens it, so the
// question comes up at a sensible moment; if it's been turned off, say where to turn it on.
const MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
async function ensureMicAccess() {
  if (!IS_MAC) return 'granted';
  let status = 'unknown';
  try {
    status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'not-determined') status = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  } catch (e) {
    logWarn('mic', 'Could not ask for microphone access', String(e?.message || e).slice(0, 200));
    return status;
  }
  logInfo('mic', `macOS microphone access: ${status}`);
  if (status === 'denied' || status === 'restricted') {
    dialog
      .showMessageBox({
        type: 'warning',
        message: "Orbit can't use the microphone",
        detail: status === 'restricted' ? "Microphone access is restricted on this Mac (for example by a device policy), so Orbit can't hear you." : 'Turn on Orbit in System Settings → Privacy & Security → Microphone, then quit and reopen Orbit.',
        buttons: status === 'restricted' ? ['OK'] : ['Open System Settings', 'Not now'],
        defaultId: 0,
      })
      .then(({ response }) => status !== 'restricted' && response === 0 && shell.openExternal(MIC_SETTINGS_URL))
      .catch(() => {});
  }
  return status;
}

// ---------- macOS permissions ----------
// What Orbit needs from System Settings → Privacy & Security: Accessibility (the Claude app and
// Orbit anywhere, through its helper, which macOS counts as Orbit), Microphone, and Screen Recording
// (only for looking at a window). Settings and a banner on the main screen show them; "Turn on"
// asks with macOS's own prompt where there is one, else opens the right pane.
const PRIVACY_PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};
function macPermissions() {
  if (!IS_MAC) return { platform: process.platform };
  const media = (k) => {
    try {
      return systemPreferences.getMediaAccessStatus(k);
    } catch {
      return 'unknown';
    }
  };
  let accessibility = false;
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  } catch {}
  return { platform: 'darwin', accessibility, microphone: media('microphone'), screen: media('screen'), helper: hasMacHelper() };
}
const askedOnce = new Set(); // macOS shows each prompt once; after that, the pane in System Settings
async function requestMacPermission(kind) {
  if (!IS_MAC || !PRIVACY_PANES[kind]) return macPermissions();
  const now = macPermissions();
  const open = () => shell.openExternal(PRIVACY_PANES[kind]).catch(() => {});
  if (kind === 'accessibility' && !now.accessibility) {
    if (askedOnce.has(kind)) open();
    else systemPreferences.isTrustedAccessibilityClient(true); // macOS's prompt (it offers to open the pane)
  } else if (kind === 'microphone' && now.microphone !== 'granted') {
    if (now.microphone === 'not-determined') await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    else open();
  } else if (kind === 'screen' && now.screen !== 'granted') {
    // No Electron call asks for it: Orbit's helper does (CGRequestScreenCaptureAccess, as Orbit).
    if (askedOnce.has(kind) || now.screen === 'denied') open();
    else await runHelperOnce(['perms', '--prompt-screen'], { timeoutMs: 5000 });
  }
  askedOnce.add(kind);
  logInfo('permissions', `asked for ${kind}`);
  return macPermissions();
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
const fromUs = (e) => isOurs(e.senderFrame?.url);
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => (fromUs(e) ? fn(...args) : undefined));
const on = (channel, fn) => ipcMain.on(channel, (e, ...args) => fromUs(e) && fn(...args));

handle('hotkey:get', () => hotkeyInfo());
handle('hotkey:set', (accel) => {
  if (typeof accel !== 'string' || !/^[\w+.-]{1,60}$/.test(accel)) return hotkeyInfo({ ok: false, error: 'No shortcut given.' });
  if (activeHotkey && activeHotkey !== accel) globalShortcut.unregister(activeHotkey);
  if (!registerHotkey(accel)) {
    if (activeHotkey) registerHotkey(activeHotkey); // put the old one back
    return hotkeyInfo({ ok: false, error: `${IS_MAC ? 'macOS' : 'Windows'} or another app is already using that shortcut. Try a different one.` });
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
handle('perms:get', () => macPermissions());
handle('perms:request', (kind) => requestMacPermission(String(kind)));
handle('update:get', () => updater?.state() ?? { status: 'idle' });
handle('update:check', () => updater?.check());
handle('update:install', () => updater?.install());

on('win:minimize', () => showOrb());
on('win:close', () => app.quit());
on('orb:restore', () => showMain());
on('orb:state', (s) => {
  orb?.webContents.send('orb:state', s);
  lastOrbState = s;
  avatarHost.onVoice(s); // the window the conversation is in gets it; the others rest
  orbitMouse.onVoice(s); // its colour and its pulse while Orbit speaks
  // Orbit woke: the mouse's windows get ready (hidden), so its first glide has its page loaded.
  if (!mouseWarm && s?.phase && s.phase !== 'off' && mouseWanted() && (process.platform === 'win32' || IS_MAC)) {
    mouseWarm = true;
    orbitMouse.prewarm();
  }
});
on('buddy:event', (name) => avatar?.event(name));
on('buddy:emote', (name) => avatarHost.active()?.emote(name));
// From the avatar's own page (not one that is fading out after a switch).
const avatarFor = (sender) => (avatar?.window && sender === avatar.window.webContents ? avatar : avatarHost.guestFor(sender));
ipcMain.on('buddy:hover', (e, over, held) => {
  if (!fromUs(e)) return;
  avatarFor(e.sender)?.hover(!!over, !!held);
});
// What became of a press on the avatar (fixed words only), for the log.
ipcMain.on('buddy:press', (e, outcome, why) => {
  if (!fromUs(e)) return;
  avatarFor(e.sender)?.pressed(outcome, why);
});
ipcMain.on('buddy:hit', (e, r) => {
  if (!fromUs(e)) return;
  const ok = r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n) && Math.abs(n) < 100_000);
  avatarFor(e.sender)?.hit(ok ? r : null);
});
// A quick click on the avatar: start talking, the same as "Hey Orbit" with its window in front (the
// main window runs the wake word's own path; the call takes that window as the one you're in).
ipcMain.on('buddy:talk', (e) => {
  if (!fromUs(e) || getSetting('avatarClickTalk') === false) return;
  const a = avatarFor(e.sender);
  if (!a) return;
  const hwnd = a.hostHwnd;
  if (hwnd) {
    const known = focus.recent?.find?.((r) => Number(r.hwnd) === hwnd);
    wakeWith(known || (a === avatar ? (IS_MAC ? { hwnd, kind: 'app', exe: 'Claude', bundle: 'com.anthropic.claudefordesktop', cls: 'AXStandardWindow', title: 'Claude' } : { hwnd, kind: 'app', exe: 'claude.exe', cls: 'Chrome_WidgetWin_1', title: 'Claude' }) : { hwnd, kind: 'app' }));
  }
  main?.webContents.send('avatar:talk');
});
// Thrown for real: "Wheee!", played by the main window (with Orbit's own audio, at the voice volume).
ipcMain.on('buddy:sound', (e, name) => {
  if (!fromUs(e) || name !== 'throw' || getSetting('avatarThrow') === false || getSetting('avatarThrowSound') === false || !avatarFor(e.sender)) return;
  main?.webContents.send('avatar:sound', 'throw');
});
// Picked up to be thrown (true) or put back (false): its window covers the work area meanwhile.
ipcMain.on('buddy:lift', (e, on) => {
  if (!fromUs(e)) return;
  const a = avatarFor(e.sender);
  if (!a) return;
  if (on && getSetting('avatarThrow') === false) return a.lift(false);
  a.lift(!!on);
});
on('orb:action', (a) => main?.webContents.send('orb:action', a));
on('orb:drag-start', () => {
  claudeTracker.pause(); // the user is moving the orb; the helper waits until they drop it
  drag = { cursor: screen.getCursorScreenPoint(), win: orb.getPosition() };
});
on('orb:drag-move', () => {
  if (!drag) return;
  const c = screen.getCursorScreenPoint();
  orb.setPosition(drag.win[0] + c.x - drag.cursor.x, drag.win[1] + c.y - drag.cursor.y);
});
on('orb:drag-end', () => {
  drag = null;
  if (sticking() && !claude.min && claudeDip) {
    // Remember the spot relative to the nearest corner of the Claude window, then snap inside it.
    const [x, y] = orb.getPosition();
    updateSettings({ orbStickAnchor: anchorFor(claudeDip, { x, y }, ORB_SIZE) });
    placeOrb();
  } else {
    updateSettings({ orbPosition: orb.getPosition() });
  }
});

app.whenReady().then(async () => {
  if (quitting) return;
  // Developer testing only (never in the installed app): a stand-in for Claude's window, so an
  // end-to-end test (scripts/fuzz-e2e.mjs) never reads, clicks or types into the real Claude app.
  if (!app.isPackaged && process.env.ORBIT_FAKE_DESKTOP) {
    const fake = await import(pathToFileURL(path.resolve(process.env.ORBIT_FAKE_DESKTOP)).href);
    setDesktopDriver(fake.default || fake);
    // ...and for the Claude window watcher too (the orb and the avatar follow its windows).
    fakeWindowHelper = (fake.default || fake).windowHelper || null;
    // ...and for the focus watcher (without one, tests run with no focus watcher at all).
    fakeFocusHelper = (fake.default || fake).focusHelper || null;
    fakeUiaHelper = (fake.default || fake).uiaHelper || null;
    fakeDesktop = true;
  }
  try {
    const dir = app.getPath('userData');
    baseUrl = await startServer({
      configDir: dir,
      secrets: PROFILE ? undefined : encryptedKeyStore(dir), // (a test profile: its .env, see above)
      brainSecrets: PROFILE ? undefined : encryptedKeyStore(dir, 'anthropic-key.bin'),
      clipboard: (text) => clipboard.writeText(text),
      // Offline wake-word model: shipped next to the app (extraResources), or in the repo in dev.
      models: app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(ROOT, 'resources', 'models'),
    });
    if (!app.isPackaged && process.env.ORBIT_FAKE_DESKTOP) logInfo('app', 'Developer mode: using a stand-in for the Claude window');
    // Connectors (Orbit anywhere): sign-in tokens sealed on disk, sign-in pages in the browser (https only).
    setMcpShell({ store: encryptedMapStore(dir, 'mcp-tokens.bin'), openExternal: (u) => (/^https:\/\//.test(u) ? shell.openExternal(u) : Promise.reject(new Error('Only https sign-in pages open.'))) });
    // Apps under Orbit (src/anywhere/keeper.js): keepers are this program in its keeper mode
    // (electron/boot.mjs), and their one-time tokens are sealed like Orbit's keys.
    setKeeperLauncher({ execPath: process.execPath, preArgs: app.isPackaged ? [] : [app.getAppPath()] });
    if (safeStorage.isEncryptionAvailable()) {
      setKeeperCrypto({
        protect: (s) => safeStorage.encryptString(String(s)).toString('base64'),
        unprotect: (s) => safeStorage.decryptString(Buffer.from(String(s), 'base64')),
      });
    }
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
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission) && isOurs(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ALLOWED_PERMISSIONS.has(permission) && !!wc && isOurs(wc.getURL()));
  app.on('web-contents-created', (_e, wc) => wc.on('will-attach-webview', (ev) => ev.preventDefault()));

  await ensureMicAccess(); // macOS: before the page opens the mic (no-op elsewhere)
  if (IS_MAC && !app.isPackaged) app.dock?.setIcon(ICON); // from source the dock shows Electron's icon otherwise
  createMain();
  createOrb();
  setAvatar();
  if (needTracker()) claudeTracker.start();
  setFocusTracking();
  createTray();
  createAppMenu();
  updater = createUpdater({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    auto: !!getSetting('autoUpdate'),
    onChange: (state) => main?.webContents.send('update:state', state),
    log: { info: (m) => logInfo('update', m), warn: (m, d) => logWarn('update', m, d) },
  });
  if (registerHotkey(getSetting('wakeHotkey'))) activeHotkey = getSetting('wakeHotkey');
  else logWarn('hotkey', `Could not register ${getSetting('wakeHotkey')}; another app may be using it`);

  if (process.env.GVB_SNAPSHOT_DIR && !app.isPackaged) {
    const { runSelfTest } = await import('./selftest.js');
    runSelfTest({ dir: process.env.GVB_SNAPSHOT_DIR, main, orb, globalShortcut, hits: () => hotkeyHits, showOrb }).finally(() => app.quit());
  }
});

app.on('before-quit', () => {
  quitting = true;
  stopBackgroundWork(); // second-brain questions kept past a hang-up stop with the app
  claudeTracker.stop();
  focusTracker?.stop();
  stopUia();
  avatar?.stop();
  avatarHost.stop();
  orbitMouse.stop();
  updater?.stop();
});
app.on('window-all-closed', () => app.quit());
// macOS: clicking the dock icon brings the main window back (from the orb). Not the activation
// that comes with launching (a login launch stays the orb).
let activateFrom = Infinity;
app.whenReady().then(() => (activateFrom = Date.now() + 2000));
app.on('activate', () => {
  if (main && !quitting && Date.now() >= activateFrom) showMain();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
