// The first-run onboarding, as Orbit Native's (mac-swift OnboardingModel + VoiceSetupView): "How
// should Orbit talk?" shows once on a brand-new install, never for an install from before; Continue
// (once the chosen voice is ready), Skip this step and Skip setup each end it for good. And a new
// install's defaults: Qubit, no floating orb, the onboarding to do; saved settings never change.
//   - src/config.js: FIRST_RUN_SETTINGS, the onboarded setting, initConfig's first run
//   - ui/src/onboarding-model.js: when it shows, when Continue can be pressed, the setup's steps
//   - ui/src/Onboarding.tsx, ui/src/App.tsx: wired in that way
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, FIRST_RUN_SETTINGS, getSettings, initConfig, sanitizeSettings, updateSettings } from '../src/config.js';
import { ONBOARDING_DONE, claudeCodeDetail, engineOf, modelsDetail, onboardingShown, refreshVoiceSetup, shouldDownload, signInAndWait, signInDetail, voiceReady } from '../ui/src/onboarding-model.js';

process.env.XAI_API_KEY = ''; // a developer's own .env key mustn't make this a "has a key" machine

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const store = (v = '') => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-onboarding-'));
const file = (dir) => path.join(dir, 'settings.json');
const saved = (dir) => JSON.parse(fs.readFileSync(file(dir), 'utf8'));
/** Launch as the desktop app does (electron/main.js passes FIRST_RUN_SETTINGS). */
const launch = (dir, key = '') => initConfig({ dir, secrets: store(key), brainSecrets: store(''), firstRun: FIRST_RUN_SETTINGS });
const st = (claudeFound, signedIn, state = 'idle', percent = 0, error = '') => ({ claudeFound, signedIn, mb: 120, models: { state, percent, error } });

test('a new install starts on Qubit with no floating orb and the onboarding to do (as Orbit Native)', () => {
  assert.deepEqual({ ...FIRST_RUN_SETTINGS }, { avatar: 'qubit', showOrb: false, onboarded: false });
  // The shared defaults are unchanged: an install from before, whose file leaves them out, keeps them.
  assert.equal(DEFAULTS.avatar, 'buddy');
  assert.equal(DEFAULTS.showOrb, true);
  assert.equal(DEFAULTS.onboarded, true);
  const dir = tmp();
  const s = launch(dir);
  assert.equal(s.avatar, 'qubit');
  assert.equal(s.showOrb, false);
  assert.equal(s.onboarded, false);
  assert.equal(s.voiceEngine, 'claude');
  // Written at once, so they read as chosen.
  assert.deepEqual(saved(dir), { voiceEngine: 'claude', avatar: 'qubit', showOrb: false, onboarded: false });
  // The next launch is the same install: nothing is applied again.
  assert.deepEqual(launch(dir).avatar, 'qubit');
  updateSettings({ avatar: 'buddy', showOrb: true });
  assert.equal(launch(dir).avatar, 'buddy', 'a choice made afterwards stays');
  assert.equal(getSettings().showOrb, true);
  // Without the desktop app's first-run settings (npm run web, the tests): as before.
  const plain = tmp();
  assert.equal(initConfig({ dir: plain, secrets: store(''), brainSecrets: store('') }).avatar, 'buddy');
  assert.deepEqual(saved(plain), { voiceEngine: 'claude' });
});

test('existing installs keep every saved value and never see the onboarding', () => {
  for (const before of [{ speed: 1.1 }, { voiceEngine: 'grok', avatar: 'none' }, { voiceEngine: 'claude' }, {}]) {
    const dir = tmp();
    const text = JSON.stringify(before, null, 2);
    fs.writeFileSync(file(dir), text);
    const s = launch(dir);
    assert.equal(s.onboarded, true, JSON.stringify(before));
    assert.equal(onboardingShown(s), false);
    assert.equal(s.avatar, before.avatar ?? 'buddy', 'the avatar it had');
    assert.equal(s.showOrb, true, 'the orb it had');
    if (before.speed) assert.equal(s.speed, before.speed);
    assert.equal(fs.readFileSync(file(dir), 'utf8'), text, 'the file is not rewritten');
  }
  // An unreadable file is still an install from before.
  const bad = tmp();
  fs.writeFileSync(file(bad), '{ nope');
  assert.equal(launch(bad).onboarded, true);
  // No settings file but an xAI key saved: an install from before too (it stays on Grok, as engineFor says).
  const keyed = tmp();
  const k = launch(keyed, 'xai-' + 'k'.repeat(40));
  assert.equal(k.voiceEngine, 'grok');
  assert.equal(k.onboarded, true);
  assert.equal(k.avatar, 'buddy');
  assert.equal(fs.existsSync(file(keyed)), false);
});

test('first launch with empty settings shows the onboarding; settings from before do not', () => {
  assert.equal(onboardingShown(launch(tmp())), true);
  const dir = tmp();
  fs.writeFileSync(file(dir), JSON.stringify({ avatar: 'qubit' }));
  assert.equal(onboardingShown(launch(dir)), false);
  // Never under the parity suite (Orbit Native shows it only with real permissions, too).
  assert.equal(onboardingShown({ onboarded: false }, { parity: true }), false);
  assert.equal(onboardingShown(null), false, 'still loading');
  assert.equal(onboardingShown({}), false, 'a shell without the setting');
  // Only a real yes or no is kept.
  assert.deepEqual(sanitizeSettings({ onboarded: 'false' }), { onboarded: false });
  assert.deepEqual(sanitizeSettings({ onboarded: 'maybe' }), {});
  assert.deepEqual(sanitizeSettings({ onboarded: 0 }), {});
});

test('Continue, Skip this step and Skip setup each end it, for good', () => {
  assert.deepEqual({ ...ONBOARDING_DONE }, { onboarded: true });
  const ui = read('ui', 'src', 'Onboarding.tsx');
  // All three buttons save ONBOARDING_DONE (Windows has no permission steps after this one).
  assert.match(ui, /const done = \(\) => void update\(ONBOARDING_DONE\)/);
  assert.match(ui, /<button onClick=\{done\} disabled=\{!ready\}[^>]*>\s*Continue\s*<\/button>/);
  assert.match(ui, /<button onClick=\{done\}[^>]*>\s*Skip this step\s*<\/button>/);
  assert.match(ui, /<button onClick=\{done\}[^>]*>\s*Skip setup\s*<\/button>/);
  // Saved: the next launch doesn't show it, and the file no longer holds onboarded: false.
  for (const label of ['Continue', 'Skip this step', 'Skip setup']) {
    const dir = tmp();
    assert.equal(onboardingShown(launch(dir)), true);
    updateSettings(ONBOARDING_DONE);
    assert.equal(onboardingShown(getSettings()), false, label);
    assert.equal(saved(dir).onboarded, undefined, `${label}: done is the default, so it isn't written out`);
    assert.equal(saved(dir).avatar, 'qubit', 'the first-run choices stay');
    assert.equal(onboardingShown(launch(dir)), false, `${label}: not again next launch`);
  }
  // The page shows it in place of the main page only (Settings and History still open), and not under parity.
  const app = read('ui', 'src', 'App.tsx');
  assert.match(app, /const onboarding = screen === "main" && onboardingShown\(settings\)/);
  assert.match(app, /\{onboarding \? \(\s*<Onboarding config=\{app\.config\} update=\{app\.updateSettings\} onKeySaved=\{app\.setHasKey\} \/>/);
});

test("Continue is enabled only once the chosen voice is ready", async () => {
  // Grok: an xAI key saved.
  assert.equal(voiceReady('grok', { hasKey: false }), false);
  assert.equal(voiceReady('grok', { hasKey: true }), true);
  assert.equal(voiceReady('grok', { hasKey: true, status: st(false, null) }), true, 'Claude Code has nothing to do with Grok');
  // Claude: Claude Code here and signed in (the models may still be downloading: a call waits for them).
  const ready = async (status, downloads = []) =>
    voiceReady('claude', {
      status: await refreshVoiceSetup({
        engine: 'claude',
        fetchStatus: async () => status,
        startDownload: async () => (downloads.push(1), { models: { state: 'downloading', percent: 0, error: '' } }),
      }),
    });
  assert.equal(await ready(null), false, "couldn't check");
  assert.equal(await ready(st(false, null)), false, 'not installed');
  assert.equal(await ready(st(true, false)), false, 'signed out');
  assert.equal(await ready(st(true, null)), false, "sign-in couldn't be checked");
  assert.equal(await ready(st(true, true, 'idle')), true);
  assert.equal(await ready(st(true, true, 'downloading', 40)), true);
  assert.equal(await ready(st(true, true, 'ready')), true);
  assert.equal(voiceReady('claude', { hasKey: true, status: st(false, null) }), false, 'an xAI key is no use to Claude voice');
  // A status endpoint that fails never enables it.
  const failing = await refreshVoiceSetup({ engine: 'claude', fetchStatus: async () => Promise.reject(new Error('down')), startDownload: async () => null });
  assert.equal(failing, null);
  assert.equal(voiceReady('claude', { status: failing }), false);
});

test('choosing Claude voice downloads its speech models at once; Grok never does', async () => {
  for (const [state, want] of [['idle', true], ['downloading', false], ['ready', false], ['error', false]]) {
    assert.equal(shouldDownload('claude', st(true, true, state)), want, state);
    assert.equal(shouldDownload('grok', st(true, true, state)), false, `grok, ${state}`);
  }
  assert.equal(shouldDownload('claude', null), false);
  const calls = [];
  const got = await refreshVoiceSetup({ engine: 'claude', fetchStatus: async () => st(false, null), startDownload: async () => (calls.push('dl'), { models: { state: 'downloading', percent: 3, error: '' } }) });
  assert.deepEqual(calls, ['dl'], 'even before Claude Code is installed, as Orbit Native');
  assert.equal(got.models.state, 'downloading');
  assert.equal(got.claudeFound, false);
  await refreshVoiceSetup({ engine: 'grok', fetchStatus: async () => st(true, true), startDownload: async () => calls.push('grok') });
  assert.deepEqual(calls, ['dl']);
  assert.equal(engineOf({ voiceEngine: 'grok' }), 'grok');
  assert.equal(engineOf({ voiceEngine: 'claude' }), 'claude');
  assert.equal(engineOf(null), 'claude');
});

test("the Claude rows say how each step stands, in Orbit Native's words", () => {
  assert.equal(claudeCodeDetail(null), 'Checking…');
  assert.equal(claudeCodeDetail(st(false, null)), 'Not installed yet');
  assert.equal(claudeCodeDetail(st(true, null)), 'Installed');
  assert.equal(signInDetail(st(false, null), null), 'After Claude Code is installed');
  assert.equal(signInDetail(st(true, false), null), 'With your Claude account');
  assert.equal(signInDetail(st(true, false), { error: null }), 'Finish in the browser that opened…');
  assert.equal(signInDetail(st(true, false), { error: "Couldn't reach Orbit." }), "Couldn't reach Orbit.");
  assert.equal(signInDetail(st(true, true), null), 'Signed in');
  assert.equal(modelsDetail(null), 'Checking…');
  assert.equal(modelsDetail(st(true, true, 'idle')), 'About 120 MB, kept on this PC');
  assert.equal(modelsDetail(st(true, true, 'downloading', 42)), 'Downloading… 42%');
  assert.equal(modelsDetail(st(true, true, 'error', 0, 'HTTP 503')), 'Download failed: HTTP 503');
  assert.equal(modelsDetail(st(true, true, 'ready')), 'Ready');
  // Not installed: the install command (the same help as the main page's notice), Check again, the guide.
  const ui = read('ui', 'src', 'Onboarding.tsx');
  assert.match(ui, /import \{ InstallCommand, SetupGuideLink, SignInStep \} from "\.\/components\/ClaudeSetup"/);
  assert.match(ui, /Copy the install command into \{where\}, run it, then press Check again\./);
  assert.match(ui, /How should Orbit talk\?/);
  assert.match(ui, /Pick one and set it up\. You can switch any time in Settings\./);
});

test('Sign in: Claude Code opens its own sign-in, then Orbit looks every 3 s until it says signed in', async () => {
  let t = 0;
  const sleeps = [];
  const io = (statuses, login = async () => ({ ok: true })) => ({
    login,
    fetchStatus: async () => statuses.shift() ?? null,
    sleep: async (ms) => (sleeps.push(ms), (t += ms)),
    now: () => t,
  });
  const seen = [];
  assert.deepEqual(await signInAndWait({ ...io([st(true, false), st(true, false), st(true, true)]), onStatus: (s) => seen.push(s.signedIn) }), { signedIn: true });
  assert.deepEqual(seen, [false, false, true]);
  assert.deepEqual(sleeps, [3000, 3000, 3000]);
  // Gives up after 3 minutes; stops when the screen goes away; says why the sign-in didn't open.
  t = 0;
  assert.deepEqual(await signInAndWait(io(Array(100).fill(st(true, false)))), { signedIn: false });
  assert.equal(t, 180_000);
  assert.deepEqual(await signInAndWait({ ...io([st(true, true)]), cancelled: () => true }), { signedIn: false });
  assert.deepEqual(await signInAndWait(io([], async () => ({ ok: false, error: 'Claude Code was not found.' }))), { error: 'Claude Code was not found.' });
  assert.deepEqual(await signInAndWait(io([], async () => ({ ok: false }))), { error: "Couldn't open the sign-in." });
  assert.deepEqual(await signInAndWait(io([], async () => Promise.reject(new Error('offline')))), { error: "Couldn't reach Orbit." });
});

test('the voice warms up at launch, and the main page says so meanwhile', () => {
  const server = read('src', 'server.js');
  assert.match(server, /if \(!speechLoaded\(voiceModelsDir\)\) setVoiceWarming\(true\)/);
  assert.match(server, /broadcast\(\{ type: 'voice\.warming', warming: on \}\)/);
  assert.match(server, /voiceWarming,\n/);
  const voice = read('src', 'claude-voice.js');
  assert.match(voice, /await tts\.generateAsync\(\{ text: 'Okay\.'/, 'one short sentence, thrown away');
  const app = read('ui', 'src', 'App.tsx');
  assert.match(app, /Getting Orbit's voice ready…/);
  assert.match(app, /const warming = !!app\.config\.voiceWarming && settings\?\.voiceEngine === "claude"/);
  assert.match(read('ui', 'src', 'useAppState.ts'), /evt\.type === "voice\.warming"/);
});

test('with the orb off, shrinking Orbit puts it on the taskbar (a way back besides the tray)', () => {
  const main = read('electron', 'main.js');
  assert.match(main, /firstRun: FIRST_RUN_SETTINGS/);
  assert.match(main, /if \(!orbAllowed\(\)\) \{\s*orb\.hide\(\);\s*if \(quiet\) main\.hide\(\);\s*else if \(!main\.isMinimized\(\)\) main\.minimize\(\);/);
  assert.match(main, /main\.on\('restore', \(\) => orbMode && showMain\(\)\)/);
  assert.match(main, /tray\.on\('click', showMain\)/, 'the tray icon still opens it');
  assert.match(read('ui', 'src', 'App.tsx'), /label=\{orbOff \? "Minimize" : "Shrink to orb"\}/);
});
