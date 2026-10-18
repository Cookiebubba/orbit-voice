// Screenshot-based self-test, run with GVB_SNAPSHOT_DIR=<dir>. Saves pictures and a JSON
// report into <dir>, then the app quits. Flags:
//   GVB_SNAPSHOT_TALK=1      click "Start talking" first (pair with XAI_REALTIME_URL pointing at a fake server)
//   GVB_SNAPSHOT_HOTKEY=1    after minimizing, press the real wake hotkey and picture the orb again
//   GVB_SNAPSHOT_SETTINGS=1  open Settings, record Ctrl+Alt+K, press it for real, then reset
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULTS, getSetting, updateSettings } from '../src/config.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sendKeys = (keys) =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`]);
// SendKeys syntax for the configured hotkey, e.g. Control+Alt+G -> ^%g
const toSendKeys = (accel) =>
  accel
    .split('+')
    .map((p) => ({ Control: '^', CommandOrControl: '^', Alt: '%', Shift: '+' })[p] ?? p.toLowerCase())
    .join('');

export async function runSelfTest({ dir, main, orb, globalShortcut, hits, showOrb }) {
  const js = (code) => main.webContents.executeJavaScript(code);
  const shot = async (win, name) => fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage()).toPNG());
  const report = {};
  await wait(3500);

  if (process.env.GVB_SNAPSHOT_WAKE) {
    // With GVB_FAKE_MIC playing a "Hey Grok" recording: does the wake word start Grok?
    const logs = [];
    main.webContents.on('console-message', (_e, level, message) => logs.push(`${level}: ${String(message).slice(0, 300)}`));
    updateSettings({ wakeWord: true });
    const text = () => js(`document.body.innerText`);
    await shot(main, 'wake-before.png');
    report.before = (await text()).slice(0, 200);
    const t0 = Date.now();
    while (Date.now() - t0 < 25000 && !/Connecting|Listening|Speaking|Thinking/.test(await text())) await wait(250);
    report.woke = /Connecting|Listening|Speaking|Thinking/.test(await text());
    report.secondsToWake = Math.round((Date.now() - t0) / 100) / 10;
    await shot(main, 'wake-after.png');
    updateSettings({ wakeWord: false });
    report.after = (await text()).slice(0, 200);
    report.console = logs.slice(-15);
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    return;
  }

  if (process.env.GVB_SNAPSHOT_VIEWS) {
    // Picture each screen without changing any settings.
    await shot(main, 'view-main.png');
    await js(`document.querySelector('button[title="Switch Claude session"]').click()`);
    await wait(3500);
    await shot(main, 'view-switcher.png');
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await js(`document.querySelector('button[aria-label="Settings"]').click()`);
    await wait(1200);
    await shot(main, 'view-settings-1.png');
    await js(`[...document.querySelectorAll('span')].find(e => e.textContent.startsWith('Wake word'))?.scrollIntoView({ block: 'center' })`);
    await wait(400);
    await shot(main, 'view-settings-wake.png');
    for (const [i, frac] of [[2, 0.45], [3, 1]]) {
      await js(`(() => { const el = [...document.querySelectorAll('div')].find(d => d.scrollHeight > d.clientHeight + 20 && getComputedStyle(d).overflowY === 'auto'); if (el) el.scrollTop = el.scrollHeight * ${frac}; })()`);
      await wait(500);
      await shot(main, `view-settings-${i}.png`);
    }
    await js(`document.querySelector('button[aria-label="History"]').click()`);
    await wait(600);
    await shot(main, 'view-history.png');
    return;
  }

  if (process.env.GVB_SNAPSHOT_SETTINGS) {
    await js(`document.querySelector('button[aria-label="Settings"]').click()`);
    await wait(1000);
    await shot(main, 'settings.png');
    await js(`document.querySelector('[data-hotkey-recorder]').scrollIntoView(); document.querySelector('[data-hotkey-recorder]').click()`);
    await wait(400);
    for (const type of ['keyDown', 'keyUp']) main.webContents.sendInputEvent({ type, keyCode: 'K', modifiers: ['control', 'alt'] });
    await wait(1200);
    await shot(main, 'settings-saved.png');
    const before = hits();
    sendKeys('^%k');
    await wait(800);
    Object.assign(report, {
      newRegistered: globalShortcut.isRegistered('Control+Alt+K'),
      globalPressReachedApp: hits() > before,
      savedSetting: getSetting('wakeHotkey'),
    });
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Reset to Ctrl')).click()`);
    await wait(800);
    report.afterReset = { setting: getSetting('wakeHotkey'), defaultRegistered: globalShortcut.isRegistered(DEFAULTS.wakeHotkey) };
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    return;
  }

  if (process.env.GVB_SNAPSHOT_TALK) {
    await js(`document.querySelector('button[aria-label="Start talking"]').click()`);
    await wait(3000);
  }
  await shot(main, 'main.png');
  showOrb();
  await wait(2500);
  await shot(orb, 'orb.png');
  report.orb = { visible: orb.isVisible(), onTop: orb.isAlwaysOnTop(), bounds: orb.getBounds(), mainVisible: main.isVisible() };
  if (process.env.GVB_SNAPSHOT_HOTKEY) {
    sendKeys(toSendKeys(getSetting('wakeHotkey')));
    await wait(1500);
    await shot(orb, 'orb-after-hotkey.png');
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
}
