#!/usr/bin/env node
// Orbit's parity suite runner (see parity/PROTOCOL.md): every case in parity/cases/*.json against
// Orbit Native (the Swift app), then a matrix (parity/out/matrix.json and matrix.md). The cases say
// what the Node core does (what the Electron app on Windows runs); the engine oracle
// (parity/oracle) pins the rest. Runs on a Mac, from the repo root:
//
//   npm run parity                               everything
//   npm run parity -- --area avatar              one area
//   npm run parity -- --case 'bridge\.config'    cases whose id matches
//   npm run parity -- --list                     the cases, no run
//
// Options: --env K=V (extra env for the apps, repeatable), --swift-app <path to "Orbit Native.app"> (default mac-swift/dist), --electron-root <a
// checkout with node_modules/electron, the stand-in Claude window's host> (default this repo), --voice-models <folder with Claude
// voice's speech models> (default ~/orbit-swift-dev/voice-models), --out <folder>, --keep (keep
// every case's temp folder; failed ones are always kept).
//
// Isolation: each case gets a fresh app with a throwaway profile, its own ports and only test
// doubles (a stand-in Grok, a stand-in Claude Code, a stand-in Claude window or desktop driver).
// Nothing here reads, clicks or types into the real Claude app or any app the runner didn't open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, startFakeGrok, startStandIn, until } from './lib/apps.mjs';
import { bridgeClient, signIn } from './lib/bridge.mjs';
import { at, interpolate, match, show } from './lib/match.mjs';
import { writeMatrix } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
// (Orbit for Mac is Orbit Native: the Electron build left the Mac, so `--app swift` is the only app.)
if (opt('app', 'swift') !== 'swift') throw new Error(`--app ${opt('app')}: only swift (Orbit Native) runs the parity suite now`);
const APPS = ['swift'];
const AREAS = opt('area', '') ? opt('area').split(',') : null;
const CASE_RE = opt('case', '') ? new RegExp(opt('case')) : null;
const OUT = path.resolve(opt('out', path.join(HERE, 'out')));
const KEEP = flag('keep');
// --env K=V (repeatable): extra environment for every app this run starts (e.g. ORBIT_SPEECH=core).
const EXTRA_ENV = Object.fromEntries(process.argv.flatMap((a, i) => (a === '--env' && process.argv[i + 1]?.includes('=') ? [process.argv[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
export const paths = {
  repo: REPO,
  swiftApp: path.resolve(opt('swift-app', path.join(REPO, 'mac-swift', 'dist', 'Orbit Native.app'))),
  electronRoot: path.resolve(opt('electron-root', REPO)),
  voiceModels: path.resolve(opt('voice-models', path.join(os.homedir(), 'orbit-swift-dev', 'voice-models'))),
  audio: path.resolve(opt('audio', path.join(HERE, 'out', 'audio'))),
};
export const PORTS = { swift: { bridge: 4521, driver: 4522 }, standin: 4525, grok: 4526 };
const FAKE_XAI_KEY = 'xai-parityfakekey0000000000000000000000';

export function loadCases(dir = path.join(HERE, 'cases')) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const out = [];
  const ids = new Set();
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const c of doc.cases || []) {
      if (!c.id || ids.has(c.id)) throw new Error(`${f}: missing or duplicate case id ${c.id}`);
      ids.add(c.id);
      out.push({ ...c, area: doc.area, file: f });
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `seconds` of silence as a 24 kHz mono 16-bit WAV. */
export function silentWav(seconds) {
  const n = Math.round(24000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

function readRecord(records, name) {
  const f = path.join(records, { 'fake-desktop': 'fake-desktop.json', 'fake-grok': 'fake-grok.json', 'fake-claude': 'fake-claude.jsonl' }[name] || name);
  if (!fs.existsSync(f)) return name === 'fake-claude' ? { turns: [], starts: [], interrupts: 0 } : null;
  if (name === 'fake-claude') {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const turns = lines.filter((l) => l.kind === 'turn' && l.reply !== 'OK');
    // What Orbit's tools returned, as the stand-in saw them ("[Tool result: name] ...").
    const toolResults = turns.flatMap((t) => [...t.text.matchAll(/\[Tool result: ([a-z_]+)\]/g)].map((m) => m[1]));
    const toolCalls = turns.flatMap((t) => [...String(t.reply).matchAll(/<tool>(\{.*?\})<\/tool>/gs)].map((m) => JSON.parse(m[1]).name));
    return { turns, toolCalls, toolResults, starts: lines.filter((l) => l.kind === 'start'), interrupts: lines.filter((l) => l.kind === 'interrupt').length };
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** Prepares a case's temp folder, profile and fixtures; returns env for the app and teardown. */
export async function prepare(c, which) {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-parity-${which}-`));
  const dirs = { run, profile: path.join(run, 'profile'), records: path.join(run, 'records'), logs: path.join(run, 'logs'), bin: path.join(run, 'bin') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const vars = { repo: REPO, records: dirs.records, profile: dirs.profile, run, app: which, audio: paths.audio };
  // The microphone is always the fake one in tests (silence until a case plays a clip into it).
  const silence = path.join(run, 'silence.wav');
  fs.writeFileSync(silence, silentWav(0.2));
  // Permission states are faked (all granted) unless a case says otherwise: with a fake microphone
  // there's nothing to ask for, and a real macOS prompt would hold an app up waiting for a click.
  const env = { PARITY_RECORD_DIR: dirs.records, ORBIT_FAKE_MIC: silence, ORBIT_FAKE_PERMS: JSON.stringify({ mic: 'granted', ax: true, screen: true }), ...EXTRA_ENV, ...interpolate(c.env || {}, vars) };
  const settings = { ...(c.profile?.settings || {}) };
  const fx = c.fixtures || {};
  const stops = [];
  let standin = null;

  if (fx.fakeDesktop) {
    env.ORBIT_FAKE_DESKTOP = path.join(REPO, 'parity', 'fixtures', 'fake-desktop.mjs');
    if (fx.fakeDesktop !== true) env.PARITY_FAKE_DESKTOP_STATE = JSON.stringify(fx.fakeDesktop);
  }
  if (fx.claudeVoice) {
    // Claude voice with real on-device speech and a scripted Claude Code.
    const rules = path.join(run, 'claude-rules.json');
    fs.writeFileSync(rules, JSON.stringify(fx.claudeVoice.rules || { rules: [] }));
    const wrapper = path.join(dirs.bin, 'claude');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexport PARITY_RECORD_DIR='${dirs.records}'\nexport PARITY_FAKE_CLAUDE_RULES='${rules}'\nexec '${process.execPath}' '${path.join(REPO, 'parity', 'fixtures', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
    Object.assign(settings, { voiceEngine: 'claude', brainClaudePath: wrapper, claudeVoiceStt: 'moonshine', claudeVoiceModel: fx.claudeVoice.model || 'haiku', ...(fx.claudeVoice.settings || {}) });
    const models = path.join(dirs.profile, 'claude-voice-models');
    if (!fs.existsSync(paths.voiceModels)) throw new Error(`no speech models at ${paths.voiceModels} (node parity/fetch-voice-models.mjs)`);
    fs.mkdirSync(models, { recursive: true });
    for (const f of fs.readdirSync(paths.voiceModels)) fs.symlinkSync(path.join(paths.voiceModels, f), path.join(models, f));
  }
  if (fx.grok) {
    // Grok is the engine here (a new install starts on Claude voice; the case's own choice wins).
    if (!('voiceEngine' in settings)) settings.voiceEngine = 'grok';
    const g = await startFakeGrok({ paths, port: PORTS.grok, recordDir: dirs.records, seed: fx.grok.seed || 1 });
    stops.push(() => g.stop());
    env.XAI_REALTIME_URL = g.url;
  }
  if (fx.standin) {
    standin = await startStandIn({ paths, port: PORTS.standin, logDir: dirs.logs, frame: fx.standin.frame });
    stops.push(() => standin.stop());
    env.ORBIT_TEST_CLAUDE_PID = String(standin.pid);
    vars.standinPid = standin.pid;
  }
  if (Object.keys(settings).length) fs.writeFileSync(path.join(dirs.profile, 'settings.json'), JSON.stringify(settings, null, 2));
  return { dirs, env, vars, standin, teardown: async () => { for (const s of stops.reverse()) await s(); } };
}

/** Runs one step; returns its result value (the thing `expect` and `save` look at). Throws on failure. */
async function step(s, ctx) {
  const x = interpolate(s, ctx.vars);
  const timeout = x.timeoutMs ?? 8000;
  const check = (value, what) => {
    if (x.expect === undefined) return value;
    const r = match(value, x.expect, ctx.vars);
    if (r) throw new Error(`${what}: ${r}`);
    return value;
  };
  const probe = async (p) => {
    switch (p.probe || p.do) {
      case 'state':
        return (await ctx.app.driver.state()).body;
      case 'hello':
        return (await ctx.app.driver.hello()).body;
      case 'http':
        return ctx.bridge.http({ method: p.method, path: p.path, body: p.body });
      case 'fake':
        return readRecord(ctx.dirs.records, p.name);
      case 'standin':
        if (!ctx.standin) throw new Error('no stand-in Claude window in this case (fixtures.standin)');
        return ctx.standin.state();
      case 'act':
        return (await ctx.app.driver.act(p.action, p.args || {})).body;
      default:
        throw new Error(`unknown probe ${p.probe}`);
    }
  };
  switch (x.do) {
    case 'http':
      return check(await ctx.bridge.http({ method: x.method || 'GET', path: x.path, body: x.body, auth: x.auth !== false, origin: x.origin, host: x.host, headers: x.headers }), `${x.method || 'GET'} ${x.path}`);
    case 'ws': {
      const r = await ctx.bridge.ws({ query: x.query, send: x.send || [], timeoutMs: timeout, origin: x.origin, auth: x.auth !== false, done: (msgs) => x.expect !== undefined && match({ opened: true, messages: msgs }, x.expect, ctx.vars) === null });
      return check(r, 'ws /voice');
    }
    case 'act': {
      const r = await ctx.app.driver.act(x.action, x.args || {}, timeout);
      if (x.expect === undefined && r.body?.ok === false) throw new Error(`act ${x.action}: ${r.body.error}`);
      return check(r.body, `act ${x.action}${r.body?.error ? ` (${String(r.body.error).slice(0, 160)})` : ''}`);
    }
    case 'state':
      return check((await ctx.app.driver.state()).body, 'state');
    case 'fake':
      return check(readRecord(ctx.dirs.records, x.name), `fake ${x.name}`);
    case 'standin': {
      if (!ctx.standin) throw new Error('no stand-in Claude window in this case (fixtures.standin)');
      if (x.op === 'set') return ctx.standin.set(x.patch || {});
      if (x.op === 'type') return ctx.standin.type(x.text || '');
      if (x.op === 'move') return ctx.standin.move(x.frame);
      return check(await ctx.standin.state(), 'stand-in');
    }
    case 'until': {
      let last;
      let why = '';
      const ok = await until(async () => {
        last = await probe(x);
        why = x.expect === undefined ? '' : match(last, x.expect, ctx.vars);
        return why === null || why === '';
      }, timeout, x.everyMs || 150);
      if (!ok) throw new Error(`until ${x.probe}${x.path ? ` ${x.path}` : ''} (${timeout} ms): ${why || 'never matched'}${last?.error ? ` (${String(last.error).slice(0, 160)})` : ''}`);
      return last;
    }
    case 'save': {
      const from = x.from === 'last' ? ctx.last : await probe({ probe: x.from, path: x.path_http, name: x.name, method: 'GET' });
      const v = at(from, x.path || '');
      if (v === undefined && !x.optional) throw new Error(`save ${x.as}: nothing at ${x.path} (${show(from).slice(0, 120)})`);
      ctx.vars[x.as] = v;
      return v;
    }
    case 'check':
      // A saved or computed value against a matcher: { "do": "check", "value": "${gap}", "expect": {...} }.
      return check(x.value, `check ${s.value}`);
    case 'calc': {
      // Arithmetic on saved numbers: "${fig.x} + ${fig.w} / 2" (numbers and + - * / ( ) only).
      const expr = String(x.expr);
      if (!/^[-+*/(). 0-9eE]+$/.test(expr)) throw new Error(`calc ${x.as}: not plain arithmetic: ${expr}`);
      const v = Function(`"use strict"; return (${expr});`)();
      if (!Number.isFinite(v)) throw new Error(`calc ${x.as}: ${expr} is not a number`);
      ctx.vars[x.as] = v;
      return v;
    }
    case 'signin': {
      // After the app relaunched itself: its bridge has a new sign-in link (one per launch).
      const h = (await ctx.app.driver.hello()).body;
      if (!h?.bridge?.authUrl) throw new Error('signin: no bridge in hello');
      ctx.bridge = bridgeClient(h.bridge.base, await signIn(h.bridge.authUrl), REPO);
      return h;
    }
    case 'sleep':
      await sleep(x.ms || 0);
      return ctx.last;
    default:
      throw new Error(`unknown step ${x.do}`);
  }
}

async function runCase(c, which, features) {
  const t0 = Date.now();
  if (features && (c.needs || []).some((n) => !features.includes(n))) {
    return { status: 'unsupported', ms: 0, error: `needs ${(c.needs || []).filter((n) => !features.includes(n)).join(', ')}` };
  }
  let prep = null;
  let app = null;
  let failed = false;
  try {
    prep = await prepare(c, which);
    app = await startApp(which, { paths, profileDir: prep.dirs.profile, logDir: prep.dirs.logs, bridgePort: PORTS[which].bridge, driverPort: PORTS[which].driver, env: prep.env });
    if (!features) features = app.hello.features || [];
    if ((c.needs || []).some((n) => !app.hello.features.includes(n))) return { status: 'unsupported', ms: Date.now() - t0, error: `needs ${(c.needs || []).filter((n) => !app.hello.features.includes(n)).join(', ')}`, features: app.hello.features };
    const cookie = await signIn(app.hello.bridge.authUrl);
    const bridge = bridgeClient(app.hello.bridge.base, cookie, REPO);
    const ctx = { app, bridge, dirs: prep.dirs, standin: prep.standin, vars: { ...prep.vars, hello: app.hello, base: app.hello.bridge.base, port: new URL(app.hello.bridge.base).port, authPath: new URL(app.hello.bridge.authUrl).pathname + new URL(app.hello.bridge.authUrl).search }, last: null };
    if (c.fixtures?.grok || c.fixtures?.key) {
      const r = await bridge.http({ method: 'POST', path: '/api/key', body: { key: c.fixtures?.key || FAKE_XAI_KEY } });
      if (r.status !== 200) throw new Error(`could not set the test key (HTTP ${r.status})`);
      // As the app's key screen does once it saved one: the app now knows it has a key.
      const k = (await app.driver.act('key.saved', {})).body;
      if (!k?.ok) throw new Error(`the app did not take the saved key: ${k?.error || 'no answer'}`);
    }
    for (let i = 0; i < c.steps.length; i++) {
      try {
        ctx.last = await step(c.steps[i], ctx);
      } catch (e) {
        throw new Error(`step ${i + 1} (${c.steps[i].do}${c.steps[i].action ? ` ${c.steps[i].action}` : ''}): ${e.message}`);
      }
    }
    return { status: 'pass', ms: Date.now() - t0, features: app.hello.features };
  } catch (e) {
    failed = true;
    return { status: /did not come up|no Swift build|no Electron|speech models/.test(e.message) ? 'error' : 'fail', ms: Date.now() - t0, error: String(e.message).slice(0, 500), dir: prep?.dirs.run, features };
  } finally {
    try {
      await app?.stop();
    } catch {}
    try {
      await prep?.teardown();
    } catch {}
    if (prep && !failed && !KEEP) fs.rmSync(prep.dirs.run, { recursive: true, force: true });
  }
}

async function main() {
  let cases = loadCases();
  if (AREAS) cases = cases.filter((c) => AREAS.includes(c.area));
  if (CASE_RE) cases = cases.filter((c) => CASE_RE.test(c.id));
  if (flag('list')) {
    for (const c of cases) console.log(`${c.id.padEnd(44)} ${c.title}`);
    return console.log(`${cases.length} cases`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const results = new Map(cases.map((c) => [c.id, { id: c.id, area: c.area, title: c.title }]));
  for (const which of APPS) {
    let features = null;
    console.log(`\n== ${which} (${cases.length} cases)`);
    for (const c of cases) {
      const r = await runCase(c, which, features);
      if (r.features && !features) features = r.features;
      results.get(c.id)[which] = { status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}), ...(r.dir ? { dir: r.dir } : {}) };
      console.log(`${r.status === 'pass' ? 'PASS' : r.status.toUpperCase().padEnd(4)} ${c.id} (${r.ms} ms)${r.error ? `: ${r.error}` : ''}`);
    }
  }
  const { json, md } = writeMatrix({ out: OUT, apps: APPS, results: [...results.values()] });
  console.log(`\n${md.split('\n## Cases')[0]}`);
  console.log(`matrix: ${json}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(2);
  });
}
