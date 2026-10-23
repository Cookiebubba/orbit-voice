// Updates from GitHub Releases (electron-updater, reading the release's latest.yml). Only published
// releases count; drafts are skipped, so nothing ships until a release is published by hand.
//
// "Update automatically" on: checks shortly after launch and every 6 hours, downloads in the
// background, and installs when Orbit quits (or at once with "Restart to update").
// Off: nothing is checked until you press "Check now" (which then downloads what it finds).
// Each download is checked against the SHA-512 in latest.yml before it's installed.
//
// Channels follow the installed version. A stable install (1.2.0) asks GitHub for its "latest"
// release, which is never a prerelease, so it is never offered a beta. A beta install
// (1.3.0-beta.1) reads the releases feed and takes the newest beta or stable above it, so it gets
// later betas and, when it ships, the stable release (and is a stable install from then on).

import electronUpdater from 'electron-updater';

const FIRST_CHECK_MS = 20_000; // let the app settle first
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Whether this version is a prerelease (1.3.0-beta.1), so its updates include later prereleases. */
export function allowsPrereleases(version = '') {
  return /^v?\d+\.\d+\.\d+-[0-9A-Za-z]/.test(String(version).trim());
}

/** A short, plain reason for Settings (the full error goes to the log). */
export function describeUpdateError(message = '') {
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(message)) return "Couldn't reach GitHub. Check your connection.";
  if (/latest\.yml|404/i.test(message)) return 'The newest release has no update info yet.';
  if (/sha512|checksum/i.test(message)) return 'The download was damaged, so it was thrown away. It will retry.';
  return "Couldn't check for updates.";
}

/**
 * state: { status, version?, percent?, message?, checkedAt? }
 * status: 'dev' (running from source: no updates) | 'idle' | 'checking' | 'latest' | 'downloading'
 *         | 'ready' (downloaded, installs on quit) | 'error'
 */
export function createUpdater({ isPackaged, auto, version = '', onChange = () => {}, log = { info() {}, warn() {} }, updater = null }) {
  let state = { status: isPackaged ? 'idle' : 'dev' };
  let timer = null;
  let firstTimer = null;
  // Created only in the installed app: reading it builds the updater, which needs a packaged app.
  // (`updater` stands in for electron-updater's in tests.)
  const autoUpdater = isPackaged ? updater || electronUpdater.autoUpdater : null;
  const set = (next) => {
    state = next;
    onChange(state);
  };

  if (isPackaged) {
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = allowsPrereleases(version || autoUpdater.currentVersion?.version);
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => set({ ...state, status: 'downloading', percent: Math.floor(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      log.info(`Orbit ${info.version} downloaded; it installs when Orbit quits`);
      set({ status: 'ready', version: info.version });
    });
    autoUpdater.on('error', (e) => {
      log.warn('Update check failed', String(e?.message || e).slice(0, 300));
      // A finished download stays ready even if a later check fails.
      if (state.status !== 'ready') set({ status: 'error', message: describeUpdateError(String(e?.message || e)) });
    });
  }

  const check = async () => {
    if (!isPackaged || state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* reported through the 'error' event */
    }
    return state;
  };

  const setAuto = (on) => {
    clearTimeout(firstTimer);
    clearInterval(timer);
    firstTimer = timer = null;
    if (!isPackaged || !on) return;
    firstTimer = setTimeout(check, FIRST_CHECK_MS);
    timer = setInterval(check, CHECK_EVERY_MS);
  };
  setAuto(auto);

  return {
    state: () => state,
    check,
    setAuto,
    /** "Restart to update": install the downloaded version silently and start it again. */
    install() {
      if (state.status !== 'ready') return false;
      autoUpdater.quitAndInstall(true, true);
      return true;
    },
    stop() {
      setAuto(false);
    },
  };
}
