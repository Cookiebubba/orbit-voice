import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenAICredentials, readWindowsOpenAIKey, validOpenAIKey } from '../electron/openai-credentials.js';
import { initConfig, getSetting, updateSettings, getOpenAIKey, getOpenAIStatus, getOpenAICredentialRevision, refreshOpenAICredentials, setOpenAIKey, onOpenAICredentialsChange, sanitizeSettings } from '../src/config.js';
import { canTalk, talkNotice } from '../ui/src/talk.js';

const processKey = 'sk-fixture-process-credential-0000000000';
const userKey = 'sk-fixture-user-credential-000000000000';
const machineKey = 'sk-fixture-machine-credential-0000000';
const savedKey = 'sk-fixture-saved-credential-0000000000';
const mem = (key = '') => ({ kind: 'memory', readState: () => key ? { state: 'present', key } : { state: 'absent' }, get: () => key, set: (v) => { key = v; } });
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-key-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const native = createOpenAICredentials({ env: {}, registry: async () => null, platform: 'win32' });
  initConfig({ dir, importEnv: false, secrets: mem(), brainSecrets: mem(), openaiSecrets: mem(), openaiCredentials: native, ...options });
  return dir;
}

test('native process precedence remains above refreshed user/machine values; metadata contains no key', async () => {
  const calls = [];
  const env = { OPENAI_API_KEY: ` ${processKey} ` };
  const source = createOpenAICredentials({ env, registry: async (scope) => { calls.push(scope); return userKey; }, platform: 'win32' });
  assert.equal(source.get(), null);
  await source.refresh();
  assert.deepEqual(source.get(), { key: processKey, source: 'process' });
  await source.refresh();
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(source.status()).includes(processKey), false);
});

test('native resolution falls through malformed/proxy process and user absence to user then machine', async () => {
  for (const inherited of ['', 'not-an-openai-key', 'sk-proxy-credential-placeholder-000000']) {
    const calls = [];
    const source = createOpenAICredentials({ env: { OPENAI_API_KEY: inherited }, platform: 'win32', registry: async (scope) => { calls.push(scope); return scope === 'user' ? userKey : machineKey; } });
    await source.refresh();
    assert.equal(source.get().key, userKey);
    assert.deepEqual(calls, ['user']);
  }
  const calls = [];
  const source = createOpenAICredentials({ env: {}, platform: 'win32', registry: async (scope) => { calls.push(scope); return scope === 'machine' ? machineKey : null; } });
  await source.refresh();
  assert.deepEqual(source.get(), { key: machineKey, source: 'machine' });
  assert.deepEqual(calls, ['user', 'machine']);
  for (const value of ['sk-local-proxy-000000000000000000', 'sk-placeholder-000000000000000', 'sk-bad key', `sk-${'x'.repeat(251)}`, '\nBearer secret', {}, 'http://127.0.0.1/key']) assert.equal(validOpenAIKey(value), '');
});

test('native refresh is deduplicated, bounded, sanitized and ignores late completion', async () => {
  let release, calls = 0;
  const source = createOpenAICredentials({ env: {}, platform: 'win32', timeoutMs: 20, registry: () => { calls++; return new Promise((r) => { release = r; }); } });
  const a = source.refresh(), b = source.refresh();
  assert.equal(a, b);
  assert.equal(source.status().pending, true);
  await a;
  assert.equal(calls, 1);
  assert.equal(source.status().error, 'system-read-failed');
  release(userKey);
  await new Promise((r) => setImmediate(r));
  assert.equal(source.get(), null);
  const bad = createOpenAICredentials({ env: {}, platform: 'win32', registry: async () => { throw new Error(`private ${userKey}`); } });
  assert.equal(JSON.stringify(await bad.refresh()).includes(userKey), false);
  const invalid = createOpenAICredentials({ env: { OPENAI_API_KEY: 'bad' }, registry: async () => null, platform: 'win32' });
  assert.equal((await invalid.refresh()).error, 'system-invalid');
});

test('registry adapter has fixed trusted command, fixed variable/roots, bounded output and sanitized failures', async () => {
  let call;
  const key = await readWindowsOpenAIKey('user', { timeoutMs: 25, run: (exe, args, options, done) => { call = { exe, args, options }; done(null, `HKEY_CURRENT_USER\\Environment\r\n    OPENAI_API_KEY    REG_SZ    ${userKey}\r\n`); } });
  assert.equal(key, userKey);
  assert.equal(call.exe, 'C:\\Windows\\System32\\reg.exe');
  assert.deepEqual(call.args, ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 25);
  assert.equal(call.options.maxBuffer, 8192);
  assert.equal(JSON.stringify(call.args).includes(userKey), false);
  assert.equal(await readWindowsOpenAIKey('machine', { run: (_exe, args, _options, done) => { assert.match(args[1], /^HKLM\\SYSTEM/); done({ code: 1 }, ''); } }), null);
  await assert.rejects(readWindowsOpenAIKey('user', { run: (_exe, _args, _options, done) => done(new Error(userKey), userKey) }), (e) => !e.message.includes(userKey));
  await assert.rejects(readWindowsOpenAIKey('user', { run: () => { throw new Error(userKey); } }), (e) => !e.message.includes(userKey));
  await assert.rejects(readWindowsOpenAIKey('user', { run: (_exe, _args, _options, done) => done(null, `HKEY_CURRENT_USER\\Environment\n    OPENAI_API_KEY    REG_SZ    ${userKey}\nextra-value-content`) }), /System key lookup failed/);
  assert.equal(await readWindowsOpenAIKey('user', { run: (_exe, _args, _options, done) => done(null, 'HKEY_CURRENT_USER\\Environment\n    OPENAI_API_KEY    REG_SZ    \n') }), '');
  await assert.rejects(readWindowsOpenAIKey('arbitrary-variable'), /System key lookup failed/);
});

test('standalone defaults saved-only; explicitly paired preview defaults auto only without saved preference', async (t) => {
  const native = createOpenAICredentials({ env: { OPENAI_API_KEY: processKey }, registry: async () => { assert.fail('registry must not run'); }, platform: 'win32' });
  setup(t, { openaiCredentials: native });
  await refreshOpenAICredentials();
  assert.equal(getSetting('openaiKeySource'), 'saved');
  assert.equal(getOpenAIKey(), '');
  assert.equal(getOpenAIStatus().systemAvailable, true);
  const dir = setup(t, { openaiCredentials: native, pairedOpenAI: true });
  await refreshOpenAICredentials();
  assert.equal(getSetting('openaiKeySource'), 'saved-or-system');
  assert.equal(getOpenAIKey(), processKey);
  assert.equal(getOpenAIStatus().savedPresent, false);
  updateSettings({ openaiKeySource: 'saved' });
  initConfig({ dir, importEnv: false, secrets: mem(), brainSecrets: mem(), openaiSecrets: mem(), openaiCredentials: native, pairedOpenAI: true });
  assert.equal(getSetting('openaiKeySource'), 'saved', 'an explicit saved-only preference survives pairing');
  assert.equal(getOpenAIKey(), '');
  assert.deepEqual(sanitizeSettings({ openaiKeySource: 'arbitrary', externalAvatarMode: 'auto' }), { externalAvatarMode: 'auto' });
});

test('saved key wins auto; corrupt saved state fails closed; system-only is an explicit opt-in', async (t) => {
  const native = createOpenAICredentials({ env: { OPENAI_API_KEY: processKey }, registry: async () => null, platform: 'win32' });
  setup(t, { openaiCredentials: native, pairedOpenAI: true, openaiSecrets: mem(savedKey) });
  await refreshOpenAICredentials();
  assert.equal(getOpenAIKey(), savedKey);
  assert.equal(getOpenAIStatus().effectiveSource, 'saved');
  setup(t, { openaiCredentials: native, pairedOpenAI: true, openaiSecrets: { get: () => '', readState: () => ({ state: 'error', present: true }), set() {} } });
  await refreshOpenAICredentials();
  assert.equal(getOpenAIStatus().savedPresent, true);
  assert.equal(getOpenAIStatus().error, 'saved-unreadable');
  assert.equal(getOpenAIStatus().systemAvailable, true);
  assert.equal(getOpenAIKey(), '');
  updateSettings({ openaiKeySource: 'system' });
  assert.equal(getOpenAIKey(), processKey);
});

test('config reads are cached, save/remove never modify system, source/account changes notify without secret hashes', async (t) => {
  let reads = 0, helpers = 0;
  const saved = mem();
  const native = createOpenAICredentials({ env: {}, registry: async (scope) => { helpers++; return scope === 'user' ? userKey : null; }, platform: 'win32' });
  const dir = setup(t, { openaiCredentials: native, pairedOpenAI: true, openaiSecrets: { ...saved, readState: () => { reads++; return saved.readState(); } } });
  await refreshOpenAICredentials();
  const before = { reads, helpers };
  for (let i = 0; i < 50; i++) { getOpenAIStatus(); getOpenAIKey(); }
  assert.deepEqual({ reads, helpers }, before);
  const events = [], off = onOpenAICredentialsChange((s) => events.push(s));
  t.after(off);
  const revision = getOpenAICredentialRevision();
  setOpenAIKey(savedKey);
  assert.equal(getOpenAIKey(), savedKey);
  assert.ok(getOpenAICredentialRevision() > revision);
  setOpenAIKey('');
  assert.equal(getOpenAIKey(), userKey);
  assert.equal(getOpenAIStatus().savedPresent, false);
  assert.equal(native.get().key, userKey);
  updateSettings({ openaiKeySource: 'system' });
  setOpenAIKey(savedKey);
  assert.equal(getOpenAIKey(), userKey);
  updateSettings({ openaiKeySource: 'saved' });
  assert.equal(getOpenAIKey(), savedKey);
  const beforeRotation = { revision: getOpenAICredentialRevision(), events: events.length };
  setOpenAIKey(machineKey); // same selected source, different account: public metadata stays identical
  assert.ok(getOpenAICredentialRevision() > beforeRotation.revision);
  assert.equal(events.length, beforeRotation.events + 1);
  const serialized = JSON.stringify(events) + fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  for (const key of [savedKey, userKey, machineKey]) assert.equal(serialized.includes(key), false);
  assert.equal(/digest|fingerprint|hash/.test(serialized), false);
});

test('UI availability and distinct OpenAI notices use effective source, not saved presence', () => {
  const config = { hasKey: false, hasOpenAIKey: false, settings: { voiceEngine: 'openai' }, externalHost: { selected: true }, openai: { available: true, policy: 'saved-or-system', effectiveSource: 'process' } };
  assert.equal(canTalk(config), true);
  config.openai.available = false;
  config.openai.pending = true;
  assert.equal(talkNotice('openai-key', config, null).kind, 'openai-key');
  assert.match(talkNotice('openai-key', config, null).text, /Checking/);
  config.openai.pending = false; config.openai.error = 'saved-unreadable';
  assert.match(talkNotice('openai-key', config, null).text, /not switched/);
  config.settings.voiceEngine = 'claude';
  assert.equal(canTalk(config), false);
  config.settings.voiceEngine = 'grok';
  assert.equal(talkNotice('grok-key', config, null).text.includes('switch to Claude'), false);
});
