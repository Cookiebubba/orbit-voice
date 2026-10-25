#!/usr/bin/env node
// The engine oracle: the Node core's own answers, saved as fixtures that Orbit Native's Swift engine
// must give exactly (mac-swift/Tests/OrbitEngineTests read them). Inputs are hand-picked edge cases
// plus seeded random ones; outputs come from running the JS. test/oracle.test.js fails when the JS
// changes and these weren't made again, so the two engines can't drift apart quietly.
//
//   node parity/oracle/gen.mjs            write parity/oracle/fixtures/*.json
//   node parity/oracle/gen.mjs --check    exit 1 if any differs (what the test does)
//
// Fixtures marked `platform: "darwin"` depend on the platform (Orbit Native's): they're made and
// checked on a Mac only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { intentFixtures } from './intent.mjs';
import { desktopFixtures } from './desktop.mjs';
import { sessionsFixtures } from './sessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures');

/** A small seeded PRNG (mulberry32), so the random cases are the same every time. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

/** JSON-safe copy (what a fixture can hold): undefined dropped, as JSON.stringify does. */
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------- settings (config.js sanitize)

const VALUES = [
  true, false, 'true', 'false', '', ' ', '  1.5 ', '1.5', '2', '0x10', '0b11', '1e3', '.5', '5.', '+1', '-1', 'abc', '1,5', 'Infinity', '\t7\n',
  0, 1, -1, 0.5, 0.004, 0.0049, 0.005, 0.0051, 0.123456, 1.005, 1.2, 1.234567, 1.5, 1.55, 2, 2.5, 3, 3.7, 7, 8, 10, 599.5, 600.4, 601, 10000, 10001, 1e21, -0.5,
  null, [], [1, 2], [1.6, 2.4], [1, 2, 3], ['1', 2], [Infinity], {}, { toString: 1 },
  { corner: 'tl', dx: 1.5, dy: 2.5 }, { corner: 'br', dx: 0, dy: 10000 }, { corner: 'xx', dx: 1, dy: 1 }, { corner: 'tr', dx: -1, dy: 1 }, { corner: 'bl', dx: '5', dy: 5 },
  ['Discord.exe', 'discord.exe', 'Slack', 'bad/name', 'my app (beta)', 'x'.repeat(81), 5, 'A+B.exe'],
  'eve', 'EVE', 'Rex_2', 'bad voice', 'a'.repeat(40), 'a'.repeat(41), 'always', 'tap', 'speak', 'chime', 'off', 'auto', 'haiku', 'sonnet', 'opus', 'fable',
  'claude-code', 'api-key', 'codex', 'grok', 'claude', 'low', 'medium', 'high', 'moonshine', 'parakeet-110m', 'parakeet-v2', 'buddy', 'qubit', 'none',
  'Command+Alt+G', 'Control+Alt+K', 'Ctrl Alt', 'é+K', 'x'.repeat(59), 'x'.repeat(60), 'grok-voice-latest',
  '/usr/local/bin/claude', '/Users/me/.local/bin/claude', '/opt/homebrew/bin/CLAUDE', '/Users/x/claude.exe', 'relative/claude', '//share/claude', '/bin/cl"aude', '/bin/claude2', '/a\tb/claude', `/${'d/'.repeat(200)}claude`,
];

export function settingsCases(sanitize, DEFAULTS) {
  const keys = Object.keys(DEFAULTS);
  const inputs = [];
  for (const k of keys) for (const v of VALUES) inputs.push({ [k]: v });
  inputs.push({ nope: 1, __proto__x: 2 }, {}, { buddy: false });
  const r = rng(20261025);
  for (let i = 0; i < 400; i++) {
    const o = {};
    const n = 1 + Math.floor(r() * 6);
    for (let j = 0; j < n; j++) o[r() < 0.1 ? `unknown${j}` : pick(r, keys)] = pick(r, VALUES);
    inputs.push(o);
  }
  // Inputs as JSON would carry them (the bridge only ever gets JSON).
  return inputs.map((i) => plain(i)).map((input) => ({ input, output: plain(sanitize(input)) }));
}

// ---------------------------------------------------------------- log scrub

export function scrubCases(scrub) {
  const fixed = [
    'key xai-abcdefgh1234 and more', 'xai-short', 'sk-ant-api03-ABCDEFGHIJ_k-l', 'Authorization: Bearer abc.def~ghi+/=', 'bearer\tXYZ123', 'Bearer tok',
    'api_key=supersecret', 'API-KEY: "zzz"', 'apikey:123', 'token = tok,next', "password 'hunter2'", 'secret:{a}', 'no secrets here', '', 'tokenless', 'my token is', 'token: x',
    'x'.repeat(1200), `${'é'.repeat(999)}xai-12345678`, '😀'.repeat(600), 'a\nb\tc',
  ];
  const r = rng(7);
  const parts = ['xai-', 'sk-ant-', 'Bearer ', 'token', '=', ':', ' ', '"', "'", 'abcDEF123', '_-', '.', '/', 'secret', 'password', 'api_key', ',', '}', '\n', 'é', '😀'];
  for (let i = 0; i < 300; i++) {
    let s = '';
    const n = 1 + Math.floor(r() * 12);
    for (let j = 0; j < n; j++) s += pick(r, parts);
    fixed.push(s);
  }
  return fixed.map((input) => ({ input, output: scrub(input) }));
}

// ---------------------------------------------------------------- hotkey labels (a Mac's)

export function hotkeyCases(hotkeyLabel) {
  const list = ['Control+Alt+G', 'Command+Alt+G', 'CommandOrControl+Shift+Space', 'CmdOrCtrl+K', 'Alt+F4', 'Super+Meta+x', 'Option+AltGr+a', 'Shift+Command+Control+Alt+Z', 'F12', 'Ctrl+Plus', '', '+', 'Control++', 'Cmd+Shift+ArrowUp', 'g'];
  return list.map((input) => ({ input, output: hotkeyLabel(input, 'darwin') }));
}

// ----------------------------------------------------------------

export async function build() {
  const root = path.resolve(HERE, '..', '..');
  const load = (...rel) => import(pathToFileURL(path.join(root, ...rel)).href);
  const config = await load('src', 'config.js');
  const log = await load('src', 'log.js');
  const system = await load('src', 'platform', 'system.js');
  return {
    // brainClaudePath's rules and the hotkey default are a Mac's here.
    settings: { platform: 'darwin', defaults: plain(config.DEFAULTS), cases: settingsCases(config.sanitizeSettings, config.DEFAULTS) },
    scrub: { platform: 'any', cases: scrubCases(log.scrub) },
    hotkey: { platform: 'any', cases: hotkeyCases(system.hotkeyLabel) },
    // The pure text modules (consent, send intent, offers, commands, cues, the avatar, prompts, continuity)...
    ...(await (async () => {
      const f = await intentFixtures(root, rng);
      // ...and which windows Orbit may read (the macOS port's policy.js: made on a Mac, from a tree with it).
      return { intent: { platform: 'any', ...f.intent }, policy: { platform: 'darwin', ...f.policy } };
    })()),
    // The Claude driver (the macOS port's platform/mac/desktop.js against its stand-in Claude).
    ...(fs.existsSync(path.join(root, 'src', 'platform', 'mac', 'desktop.js')) ? { desktop: { platform: 'darwin', ...(await desktopFixtures(root)) } } : {}),
    // Claude Code's sessions on disk and the watcher (a Mac's folders: made on a Mac).
    ...(process.platform === 'darwin' ? { sessions: { platform: 'darwin', ...sessionsFixtures() } } : {}),
  };
}

/** Which fixtures differ from what the JS gives now (those this platform can make). */
export async function stale() {
  const out = [];
  for (const [name, data] of Object.entries(await build())) {
    if (data.platform === 'darwin' && process.platform !== 'darwin') continue;
    const file = path.join(FIXTURES, `${name}.json`);
    const now = `${JSON.stringify(data, null, 1)}\n`;
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== now) out.push(name);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const s = await stale();
    if (s.length) {
      console.error(`stale engine oracle fixtures: ${s.join(', ')} (node parity/oracle/gen.mjs on a Mac)`);
      process.exit(1);
    }
    console.log('engine oracle fixtures are current');
  } else {
    fs.mkdirSync(FIXTURES, { recursive: true });
    for (const [name, data] of Object.entries(await build())) {
      if (data.platform === 'darwin' && process.platform !== 'darwin') {
        console.log(`(skipped ${name}: made on a Mac only)`);
        continue;
      }
      fs.writeFileSync(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(data, null, 1)}\n`);
      console.log(`${name}: ${(data.cases || data.scenarios || data.steps || []).length} ${data.scenarios ? 'scenarios' : data.steps ? 'steps' : 'cases'}`);
    }
  }
}
