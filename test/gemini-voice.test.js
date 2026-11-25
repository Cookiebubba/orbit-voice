// Tests for Gemini Auth (src/gemini/auth.js), Local-Speech + Gemini CLI Voice Engine
// (src/gemini/cli-voice.js), and Gemini Multimodal Live WebSocket Engine (src/gemini/live-voice.js).
// OS-independent: uses fake processes, fake speech models, temp directories, and a local 127.0.0.1
// fake Gemini Live WebSocket server. Nothing is downloaded, spawned against real CLIs, or billed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  GEMINI_LIVE_MODELS,
  GEMINI_LIVE_VOICES,
  GEMINI_VOICE_MODELS,
  findGemini,
  geminiAuthStatus,
  isGeminiFile,
  isGeminiSignInProblem,
  openGeminiSignIn,
} from '../src/gemini/auth.js';
import {
  GEMINI_VOICE,
  GeminiCliProc,
  createGeminiCliRealtime,
  stopGeminiVoice,
} from '../src/gemini/cli-voice.js';
import {
  GEMINI_LIVE_DEFAULTS,
  createGeminiLiveRealtime,
  resamplePcm16,
  toGeminiTools,
} from '../src/gemini/live-voice.js';
import { createFakeGeminiLive } from './e2e/fake-gemini-live.mjs';

function collect(sock) {
  const events = [];
  sock.on('message', (d) => events.push(JSON.parse(String(d))));
  return events;
}

const until = async (fn, ms = 2500) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const opened = (sock) => new Promise((r) => sock.once('open', r));

/** Fake child process returning fixed stdout/stderr and exit code. */
function fakeAuthProc(stdout = '', { stderr = '', code = 0, calls = [], hang = false, error = null } = {}) {
  const impl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.kill = () => setImmediate(() => child.emit('close', null));
    child.unref = () => { calls.at(-1).unref = true; };
    calls.push({ exe, args, opts });
    if (error) {
      setImmediate(() => child.emit('error', error));
      return child;
    }
    setImmediate(() => child.emit('spawn'));
    if (!hang) {
      setTimeout(() => {
        if (stdout) child.stdout.write(stdout);
        child.stdout.end();
        if (stderr) child.stderr.write(stderr);
        child.stderr.end();
        child.emit('close', code);
      }, 5);
    }
    return child;
  };
  return { impl, calls };
}

/** Fake speech models: silent unless VAD segments are pushed, speaks 10 ms per piece. */
function fakeSpeech({ transcript = 'hello' } = {}) {
  const vad = {
    detected: false,
    segments: [],
    acceptWaveform() {},
    isDetected() { return this.detected; },
    isEmpty() { return !this.segments.length; },
    front() { return this.segments[0]; },
    pop() { this.segments.shift(); },
    reset() { this.segments = []; },
  };
  return {
    vad,
    said: [],
    newVad: () => vad,
    newResampler: () => ({ resample: (f) => f.subarray(0, Math.floor((f.length * 2) / 3)) }),
    async transcribe() {
      return transcript;
    },
    async speak(text) {
      this.said.push(text);
      return new Float32Array(240);
    },
  };
}

/**
 * Fake `gemini` CLI process per turn: reads prompt from stdin, emits Gemini stream-json events
 * (`init`, assistant `message` deltas, `result`).
 */
function fakeGeminiCli(script, { sessionId = 'gem_sess_1', delayMs = 2 } = {}) {
  const calls = [];
  const spawnImpl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    let killed = false;
    child.kill = () => {
      if (killed) return;
      killed = true;
      call.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    const promptFile = opts?.env?.GEMINI_SYSTEM_MD || '';
    const systemPromptText = promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
    const call = { exe, args, opts, stdin: '', systemPromptText, killed: false };
    calls.push(call);

    let input = '';
    child.stdin.on('data', (d) => { input += d; });
    child.stdin.on('end', async () => {
      call.stdin = input;
      const nth = calls.length;
      const res = script(input, nth, call);
      const out = (o) => !killed && child.stdout.write(`${JSON.stringify(o)}\n`);
      await new Promise((r) => setImmediate(r));
      if (killed) return;
      if (res && res.error) {
        out({ type: 'init', session_id: sessionId });
        out({ type: 'result', status: 'error', error: { message: res.error } });
        child.stdout.end();
        child.emit('close', 1);
        return;
      }
      if (res && res.crash) {
        child.stderr.end(res.crash);
        child.stdout.end();
        child.emit('close', 1);
        return;
      }
      out({ type: 'init', session_id: sessionId });
      const pieces = Array.isArray(res) ? res : [String(res ?? '')];
      for (const piece of pieces) {
        if (killed) return;
        out({ type: 'message', role: 'assistant', content: piece, delta: true });
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      if (killed) return;
      out({ type: 'result', status: 'success' });
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };
  return { calls, spawnImpl };
}

// ============================================================================
// 1. src/gemini/auth.js
// ============================================================================

test('auth: model and voice catalogs match expected names and are frozen', () => {
  assert.deepEqual(Object.keys(GEMINI_VOICE_MODELS), ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']);
  assert.deepEqual(Object.keys(GEMINI_LIVE_MODELS), ['gemini-2.5-flash-native-audio-preview-12-2025', 'gemini-2.0-flash-live-001']);
  assert.deepEqual([...GEMINI_LIVE_VOICES], ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']);
  assert.ok(Object.isFrozen(GEMINI_VOICE_MODELS));
  assert.ok(Object.isFrozen(GEMINI_LIVE_MODELS));
  assert.ok(Object.isFrozen(GEMINI_LIVE_VOICES));
});

test('auth: isGeminiFile validates executable names per platform', () => {
  assert.equal(isGeminiFile('/usr/local/bin/gemini', 'darwin'), true);
  assert.equal(isGeminiFile('/usr/bin/gemini', 'linux'), true);
  assert.equal(isGeminiFile('/usr/bin/gemini.exe', 'linux'), true);
  assert.equal(isGeminiFile('/usr/bin/gemini-cli', 'darwin'), false);
  assert.equal(isGeminiFile('/usr/bin/claude', 'darwin'), false);

  assert.equal(isGeminiFile('C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd', 'win32'), true);
  assert.equal(isGeminiFile('C:\\bin\\GEMINI.EXE', 'win32'), true);
  assert.equal(isGeminiFile('C:\\bin\\gemini', 'win32'), false, 'bare gemini rejected on Windows');
  assert.equal(isGeminiFile('C:\\bin\\gemini.bat', 'win32'), false);
  assert.equal(isGeminiFile('C:\\bin\\evil.exe', 'win32'), false);
});

test('auth: findGemini resolves configured path, PATH, shellPath, and Windows npm folder', () => {
  const existing = new Set(['/opt/homebrew/bin/gemini', '/custom/bin/gemini']);
  const exists = (p) => existing.has(p);

  assert.deepEqual(
    findGemini('/custom/bin/gemini', {}, { platform: 'darwin', homedir: '/Users/me', shellPath: [], exists }),
    { path: '/custom/bin/gemini', source: 'settings' },
  );
  // Rejects relative, UNC, or non-gemini configured paths.
  assert.equal(findGemini('gemini', {}, { platform: 'darwin', exists: () => true }), null);
  assert.equal(findGemini('//server/share/gemini', {}, { platform: 'darwin', exists: () => true }), null);
  assert.equal(findGemini('/usr/bin/bash', {}, { platform: 'darwin', exists: () => true }), null);

  // Finds via searchDirs on macOS (well-known /opt/homebrew/bin or shellPath).
  assert.deepEqual(
    findGemini('', { PATH: '/usr/bin' }, { platform: 'darwin', homedir: '/Users/me', shellPath: ['/opt/homebrew/bin'], exists }),
    { path: '/opt/homebrew/bin/gemini', source: 'path' },
  );

  // Finds gemini.cmd in Windows AppData\Roaming\npm even if PATH lacks it.
  const winExisting = new Set(['C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd']);
  assert.deepEqual(
    findGemini('', { PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, {
      platform: 'win32',
      homedir: 'C:\\Users\\me',
      exists: (p) => winExisting.has(p),
    }),
    { path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd', source: 'path' },
  );

  // Returns null when not installed.
  assert.equal(findGemini('', { PATH: '/usr/bin' }, { platform: 'linux', homedir: '/home/me', exists: () => false }), null);
});

test('auth: isGeminiSignInProblem flags auth failures and ignores rate limits or crashes', () => {
  for (const msg of [
    'UNAUTHENTICATED: Request had invalid authentication credentials.',
    'OAuth token has expired and could not be refreshed',
    'invalid_grant: Token has been expired or revoked.',
    'API key not valid. Please pass a valid API key.',
    'Error 401 Unauthorized',
    'Not logged in. Please sign in.',
    'Authentication required',
  ]) {
    assert.equal(isGeminiSignInProblem(msg), true, msg);
  }
  for (const msg of [
    'RESOURCE_EXHAUSTED: Quota exceeded',
    'Rate limit reached (429)',
    'Model overloaded, try again later',
    'ECONNRESET',
    '',
  ]) {
    assert.equal(isGeminiSignInProblem(msg), false, msg);
  }
});

test('auth: geminiAuthStatus checks cached OAuth, env API key, CLI fallback, timeout, and missing path', async () => {
  assert.equal((await geminiAuthStatus({ geminiPath: '' })).ok, false);

  // Valid cached OAuth refresh_token in homedir/.gemini/oauth_creds.json.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gem-auth-'));
  try {
    fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'rt_123' }));
    assert.deepEqual(
      await geminiAuthStatus({ geminiPath: '/x/gemini', homedir: tmpHome, env: {} }),
      { ok: true, signedIn: true, method: 'oauth' },
    );

    // Expired access_token without refresh_token -> not signed in, falls through to CLI check.
    fs.writeFileSync(
      path.join(tmpHome, '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'at_old', expiry_date: Date.now() - 60_000 }),
    );
    const ver = fakeAuthProc('0.1.20\n');
    assert.deepEqual(
      await geminiAuthStatus({ geminiPath: '/x/gemini', homedir: tmpHome, env: {}, spawnImpl: ver.impl }),
      { ok: true, signedIn: false, method: 'oauth-expired' },
    );
    assert.deepEqual(ver.calls[0].args, ['--version']);
    assert.equal(ver.calls[0].opts.env.GEMINI_API_KEY, undefined);

    // Explicit GEMINI_API_KEY in env -> api-key auth.
    assert.deepEqual(
      await geminiAuthStatus({ geminiPath: '/x/gemini', homedir: tmpHome, env: { GEMINI_API_KEY: 'AIza-test' } }),
      { ok: true, signedIn: true, method: 'api-key' },
    );

    // No credentials at all, CLI responds to --version -> signedIn: false.
    fs.rmSync(path.join(tmpHome, '.gemini', 'oauth_creds.json'));
    const okCli = fakeAuthProc('0.2.0\n');
    assert.deepEqual(
      await geminiAuthStatus({ geminiPath: '/x/gemini', homedir: tmpHome, env: {}, spawnImpl: okCli.impl }),
      { ok: true, signedIn: false, method: null },
    );

    // Hanging CLI respects timeoutMs.
    const slow = await geminiAuthStatus({
      geminiPath: '/x/gemini',
      homedir: tmpHome,
      env: {},
      spawnImpl: fakeAuthProc('', { hang: true }).impl,
      timeoutMs: 30,
    });
    assert.equal(slow.ok, false);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('auth: openGeminiSignIn launches directly on Windows and via self-removing .command on macOS', async () => {
  assert.equal((await openGeminiSignIn({ geminiPath: '' })).ok, false);

  const winCalls = [];
  const winRes = await openGeminiSignIn({
    geminiPath: 'C:\\npm\\gemini.cmd',
    platform: 'win32',
    spawnImpl: fakeAuthProc('', { calls: winCalls, hang: true }).impl,
  });
  assert.equal(winRes.ok, true);
  assert.equal(winCalls[0].exe, 'C:\\npm\\gemini.cmd');
  assert.deepEqual(winCalls[0].args, []);
  assert.equal(winCalls[0].opts.detached, true);
  assert.equal(winCalls[0].opts.windowsHide, false);
  assert.equal(winCalls[0].opts.shell, undefined);
  assert.equal(winCalls[0].unref, true);

  const macCalls = [];
  const macRes = await openGeminiSignIn({
    geminiPath: '/opt/homebrew/bin/gemini',
    platform: 'darwin',
    spawnImpl: fakeAuthProc('', { calls: macCalls, hang: true }).impl,
  });
  assert.equal(macRes.ok, true);
  assert.equal(macCalls[0].exe, '/usr/bin/open');
  const cmdFile = macCalls[0].args[0];
  assert.match(cmdFile, /orbit-gemini-sign-in-.*\.command$/);
  const content = fs.readFileSync(cmdFile, 'utf8');
  assert.match(content, /rm -f/);
  assert.match(content, /exec '\/opt\/homebrew\/bin\/gemini'/);
  fs.rmSync(cmdFile, { force: true });
});

// ============================================================================
// 2. src/gemini/cli-voice.js
// ============================================================================

test('cli-voice: strips GEMINI_API_KEY and ELECTRON_RUN_AS_NODE by default, passes explicit apiKey, uses isolated temp cwd', async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevNode = process.env.ELECTRON_RUN_AS_NODE;
  process.env.GEMINI_API_KEY = 'should-be-stripped';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const fg = fakeGeminiCli(() => ['Hi there.']);
    const sock = createGeminiCliRealtime({ geminiPath: '/bin/gemini', speech: fakeSpeech(), spawnImpl: fg.spawnImpl });
    const ev = collect(sock);
    await opened(sock);
    sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'Be Orbit.', tools: [] } }));
    sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }));
    sock.send(JSON.stringify({ type: 'response.create' }));
    await until(() => ev.some((e) => e.type === 'response.done'));

    const call = fg.calls[0];
    assert.equal(call.opts.env.GEMINI_API_KEY, undefined, 'env GEMINI_API_KEY stripped');
    assert.equal(call.opts.env.ELECTRON_RUN_AS_NODE, undefined, 'ELECTRON_RUN_AS_NODE stripped');
    assert.ok(call.opts.cwd.includes('orbit-gemini-voice-not-a-project'), 'runs in isolated temp cwd');
    assert.equal(call.opts.shell, undefined);
    assert.match(call.systemPromptText, /Be Orbit\./);
    assert.equal(call.args[call.args.indexOf('--model') + 1], GEMINI_VOICE.model);
    assert.equal(call.stdin, 'hello');
    sock.close();

    // Explicit apiKey IS passed.
    const fg2 = fakeGeminiCli(() => ['With key.']);
    const sock2 = createGeminiCliRealtime({
      geminiPath: '/bin/gemini',
      apiKey: 'AIza-explicit-key',
      speech: fakeSpeech(),
      spawnImpl: fg2.spawnImpl,
    });
    const ev2 = collect(sock2);
    await opened(sock2);
    sock2.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
    sock2.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] } }));
    sock2.send(JSON.stringify({ type: 'response.create' }));
    await until(() => ev2.some((e) => e.type === 'response.done'));
    assert.equal(fg2.calls[0].opts.env.GEMINI_API_KEY, 'AIza-explicit-key');
    sock2.close();
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    if (prevNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prevNode;
  }
});

test('cli-voice: streams speech, emote cues, tool calls, tool results, and session resumption', async () => {
  const fg = fakeGeminiCli((_text, nth) =>
    nth === 1
      ? ['<happy> Let me ', 'check. <to', 'ol>{"name":"get_current_session","arguments":{}}</tool>']
      : ['Claude is idle.'],
  );
  const speech = fakeSpeech();
  const sock = createGeminiCliRealtime({ geminiPath: '/bin/gemini', speech, spawnImpl: fg.spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({
    type: 'session.update',
    session: { instructions: 'x', tools: [{ name: 'get_current_session', description: 'd', parameters: {} }] },
  }));
  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "what's up?" }] } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  await until(() => ev.some((e) => e.type === 'response.done'));

  const call = ev.find((e) => e.type === 'response.function_call_arguments.done');
  assert.equal(call.name, 'get_current_session');
  assert.equal(call.arguments, '{}');
  assert.ok(speech.said.includes('Let me check.'));
  assert.ok(!speech.said.some((s) => /tool|happy/.test(s)), 'tool call and emote cue are never spoken');
  const audioEv = ev.find((e) => e.type === 'response.output_audio.delta' && e.emote);
  assert.deepEqual(audioEv?.emote, { name: 'happy' });

  const types = ev.map((e) => e.type);
  assert.ok(types.indexOf('response.output_audio.delta') < types.indexOf('response.function_call_arguments.done'));
  assert.ok(types.indexOf('response.function_call_arguments.done') < types.indexOf('response.done'));

  // Send tool result back and verify --resume is passed on the second turn.
  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: '{"ok":true}' } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  await until(() => ev.filter((e) => e.type === 'response.done').length === 2);
  assert.equal(fg.calls[1].stdin, '[Tool result: get_current_session] {"ok":true}');
  assert.equal(fg.calls[1].args[fg.calls[1].args.indexOf('--resume') + 1], 'gem_sess_1');
  assert.equal(ev.filter((e) => e.type === 'response.output_audio_transcript.done').at(-1).transcript, 'Claude is idle.');
  sock.close();
});

test('cli-voice: VAD speech in, barge-in cancel, localTurn, localSpeech, and mid-call model switch', async () => {
  const fg = fakeGeminiCli(() => ['This is a long answer, ', 'with many words. ', 'And more. '.repeat(25)], { delayMs: 6 });
  const speech = fakeSpeech({ transcript: 'What time is it?' });
  const sock = createGeminiCliRealtime({
    geminiPath: '/bin/gemini',
    speech,
    spawnImpl: fg.spawnImpl,
    localTurn: (text) => (/backflip/.test(text) ? { note: '[Orbit note: did a backflip.]' } : null),
  });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  const mic = Buffer.alloc(2048 * 2).toString('base64');

  // Local turn skips Gemini CLI and attaches note to next turn.
  speech.transcribe = async () => 'do a backflip';
  speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev.some((e) => e.type === 'conversation.item.input_audio_transcription.completed'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fg.calls.length, 0);

  // Real speech triggers Gemini CLI with the local note prepended.
  speech.transcribe = async () => 'What time is it?';
  speech.vad.detected = true;
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  speech.vad.detected = false;
  speech.vad.segments.push({ start: 0, samples: new Float32Array(1024) });
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev.some((e) => e.type === 'response.output_audio.delta'));
  assert.match(fg.calls[0].stdin, /^\[Orbit note: did a backflip\.\]\n\nWhat time is it\?$/);

  // Talking over the reply cancels it and kills the active turn child.
  speech.vad.detected = true;
  sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  assert.equal(ev.find((e) => e.type === 'response.done').response.status, 'cancelled');
  assert.equal(fg.calls[0].killed, true);

  // Mid-call model update switches model on the next turn; unknown model is ignored.
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [], gemini_model: 'gemini-2.5-pro' } }));
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [], gemini_model: 'unknown-model' } }));
  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  await until(() => fg.calls.length === 2);
  assert.equal(fg.calls[1].args[fg.calls[1].args.indexOf('--model') + 1], 'gemini-2.5-pro');
  sock.close();

  // localSpeech mode: no VAD/TTS created, words out with empty delta.
  let vadCount = 0;
  const fgLocal = fakeGeminiCli(() => ['All good.']);
  const sockLocal = createGeminiCliRealtime({
    geminiPath: '/bin/gemini',
    speech: { ...fakeSpeech(), newVad: () => (vadCount++, fakeSpeech().vad) },
    spawnImpl: fgLocal.spawnImpl,
    localSpeech: true,
    sid: 2,
    speed: 1.2,
  });
  const evLocal = collect(sockLocal);
  await opened(sockLocal);
  assert.equal(vadCount, 0);
  sockLocal.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  sockLocal.send(JSON.stringify({ type: 'orbit.speech_started' }));
  sockLocal.send(JSON.stringify({ type: 'orbit.transcript', transcript: 'Status?', ended_ms_ago: 200 }));
  await until(() => evLocal.some((e) => e.type === 'response.done'));
  const deltaEv = evLocal.find((e) => e.type === 'response.output_audio.delta');
  assert.equal(deltaEv.delta, '');
  assert.equal(deltaEv.text, 'All good.');
  assert.deepEqual(deltaEv.voice, { sid: 2, speed: 1.2 });
  sockLocal.close();
});

test('cli-voice: reports sign-in errors, missing CLI, and stopGeminiVoice kills live procs', async () => {
  // Missing geminiPath emits error and closes with 1011.
  const noCli = createGeminiCliRealtime({ geminiPath: '', speech: fakeSpeech() });
  const evNo = collect(noCli);
  const closed = await new Promise((r) => noCli.once('close', (code) => r(code)));
  assert.equal(closed, 1011);
  assert.match(evNo.find((e) => e.type === 'error').error.message, /Gemini CLI was not found/);

  // Sign-in error from CLI emits sign-in message.
  const fgErr = fakeGeminiCli(() => ({ error: 'UNAUTHENTICATED: OAuth token expired' }));
  const sock = createGeminiCliRealtime({ geminiPath: '/bin/gemini', speech: fakeSpeech(), spawnImpl: fgErr.spawnImpl });
  const ev = collect(sock);
  await opened(sock);
  sock.send(JSON.stringify({ type: 'session.update', session: { instructions: 'x', tools: [] } }));
  sock.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }));
  sock.send(JSON.stringify({ type: 'response.create' }));
  await until(() => ev.some((e) => e.type === 'response.done'));
  assert.match(ev.find((e) => e.type === 'error').error.message, /sign-in has expired/);
  sock.close();

  // stopGeminiVoice kills active GeminiCliProc instances cleanly.
  const p = new GeminiCliProc({ exe: '/bin/gemini', prompt: 'hi', spawnImpl: fakeAuthProc('', { hang: true }).impl });
  assert.equal(p.dead, false);
  stopGeminiVoice();
  assert.equal(p.dead, true);
});

// ============================================================================
// 3. src/gemini/live-voice.js (helpers + against fake-gemini-live.mjs)
// ============================================================================

test('live-voice: resamplePcm16 accurately converts 24kHz <-> 16kHz and handles edge cases', () => {
  // 2400 samples @ 24kHz (100ms, 4800 bytes) -> 1600 samples @ 16kHz (3200 bytes).
  const in24 = Buffer.alloc(2400 * 2);
  for (let i = 0; i < 2400; i++) in24.writeInt16LE(12345, i * 2);
  const out16 = resamplePcm16(in24, 24000, 16000);
  assert.equal(out16.length, 1600 * 2);
  for (let i = 0; i < 1600; i++) assert.equal(out16.readInt16LE(i * 2), 12345, 'DC preserved');

  // Upsampling 16kHz -> 24kHz.
  const up24 = resamplePcm16(out16, 16000, 24000);
  assert.equal(up24.length, 2400 * 2);
  assert.equal(up24.readInt16LE(0), 12345);

  // Same rate returns a copy of equal length.
  const same = resamplePcm16(in24, 24000, 24000);
  assert.equal(same.length, in24.length);
  assert.notEqual(same, in24);

  // Empty / invalid inputs return empty Buffer.
  assert.equal(resamplePcm16(Buffer.alloc(0), 24000, 16000).length, 0);
  assert.equal(resamplePcm16(Buffer.alloc(1), 24000, 16000).length, 0);
  assert.equal(resamplePcm16(in24, 0, 16000).length, 0);
});

test('live-voice: toGeminiTools converts Orbit tools, sanitizes schemas, drops xAI search tools, adds googleSearch', () => {
  const orbitTools = [
    {
      type: 'function',
      name: 'read_session',
      description: 'Read recent messages.',
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        properties: {
          last_n: { type: 'integer', description: 'Count', default: 8 },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['last_n'],
      },
    },
    { type: 'web_search' },
    { type: 'x_search' },
  ];

  const withoutSearch = toGeminiTools(orbitTools, { webSearch: false });
  assert.equal(withoutSearch.length, 1);
  assert.equal(withoutSearch[0].functionDeclarations.length, 1);
  const decl = withoutSearch[0].functionDeclarations[0];
  assert.equal(decl.name, 'read_session');
  assert.equal(decl.parameters.type, 'OBJECT');
  assert.equal(decl.parameters.additionalProperties, undefined);
  assert.equal(decl.parameters.$schema, undefined);
  assert.equal(decl.parameters.properties.last_n.type, 'INTEGER');
  assert.equal(decl.parameters.properties.last_n.default, undefined);
  assert.deepEqual(decl.parameters.properties.tags, { type: 'ARRAY', items: { type: 'STRING' } });
  assert.deepEqual(decl.parameters.required, ['last_n']);

  const withSearch = toGeminiTools(orbitTools, { webSearch: true });
  assert.equal(withSearch.length, 2);
  assert.deepEqual(withSearch[1], { googleSearch: {} });

  assert.deepEqual(toGeminiTools([], { webSearch: true }), [{ googleSearch: {} }]);
  assert.deepEqual(toGeminiTools([], { webSearch: false }), []);
});

test('live-voice: missing apiKey fails and closes with 1011', async () => {
  const sock = createGeminiLiveRealtime({ apiKey: '' });
  const ev = collect(sock);
  const code = await new Promise((r) => sock.once('close', (c) => r(c)));
  assert.equal(code, 1011);
  assert.match(ev.find((e) => e.type === 'error').error.message, /API key is missing/);
});

test('live-voice: buffers outgoing frames until setupComplete and translates audio, vision, text, tools, cancel, and barge-in', async () => {
  const fake = createFakeGeminiLive({ autoSetupComplete: false });
  await fake.ready;
  const warns = [];
  const sock = createGeminiLiveRealtime({
    apiKey: 'AIza-secret-live-key',
    model: GEMINI_LIVE_DEFAULTS.model,
    voice: 'Kore',
    webSearch: true,
    liveUrl: fake.url,
    onWarn: (what, detail) => warns.push({ what, detail }),
  });
  const ev = collect(sock);

  try {
    await opened(sock);
    assert.equal(fake.current().headers['x-goog-api-key'], 'AIza-secret-live-key');

    // 1. Send session.update -> triggers `setup`, then queue audio + text BEFORE setupComplete!
    sock.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: 'You are Orbit.',
        tools: [{ type: 'function', name: 'list_sessions', description: 'List sessions', parameters: { type: 'object', properties: {} } }],
      },
    }));
    const mic24 = Buffer.alloc(2400 * 2, 0x11).toString('base64');
    sock.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic24 }));
    sock.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check sessions' }] },
    }));
    sock.send(JSON.stringify({ type: 'response.create' }));

    await until(() => fake.received.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    // Only `setup` should have been sent so far; audio + clientContent are buffered!
    assert.equal(fake.received.length, 1, 'frames before setupComplete are buffered');
    assert.equal(fake.received[0].setup.model, `models/${GEMINI_LIVE_DEFAULTS.model}`);
    assert.equal(fake.received[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.equal(fake.received[0].setup.systemInstruction.parts[0].text, 'You are Orbit.');
    assert.ok(fake.received[0].setup.tools.some((t) => t.functionDeclarations?.[0]?.name === 'list_sessions'));
    assert.ok(fake.received[0].setup.tools.some((t) => t.googleSearch));

    // Complete setup -> Orbit receives session.updated and buffered frames flush in exact order.
    fake.sendSetupComplete();
    await until(() => fake.received.length === 4);
    assert.ok(ev.some((e) => e.type === 'session.updated'));

    // Audio was resampled from 24kHz (4800 bytes) -> 16kHz (3200 bytes).
    const audioMsg = fake.received[1];
    assert.equal(audioMsg.realtimeInput.mediaChunks[0].mimeType, 'audio/pcm;rate=16000');
    assert.equal(Buffer.from(audioMsg.realtimeInput.mediaChunks[0].data, 'base64').length, 1600 * 2);

    // Text turn + turnComplete flushed after audio.
    assert.equal(fake.received[2].clientContent.turns[0].parts[0].text, 'Check sessions');
    assert.equal(fake.received[2].clientContent.turnComplete, false);
    assert.equal(fake.received[3].clientContent.turnComplete, true);

    // 2. Vision frames: valid JPEG passes; >512KB, offLimits flag, off-limits window, and non-JPEG are refused.
    const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
    sock.send(JSON.stringify({ type: 'orbit.vision_frame', mimeType: 'image/jpeg', data: validJpeg }));
    await until(() => fake.received.length === 5);
    assert.equal(fake.received[4].realtimeInput.mediaChunks[0].mimeType, 'image/jpeg');
    assert.equal(fake.received[4].realtimeInput.mediaChunks[0].data, validJpeg);

    const tooBig = Buffer.alloc(GEMINI_LIVE_DEFAULTS.maxVisionBytes + 1, 0xff).toString('base64');
    sock.send(JSON.stringify({ type: 'orbit.vision_frame', mimeType: 'image/jpeg', data: tooBig }));
    sock.send(JSON.stringify({ type: 'orbit.vision_frame', mimeType: 'image/jpeg', data: validJpeg, offLimits: true }));
    sock.send(JSON.stringify({
      type: 'orbit.vision_frame',
      mimeType: 'image/jpeg',
      data: validJpeg,
      window: { hwnd: 1, exe: '1password.exe', title: '1Password' },
    }));
    sock.send(JSON.stringify({ type: 'orbit.vision_frame', mimeType: 'image/svg+xml', data: validJpeg }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fake.received.length, 5, 'oversized, offLimits, policy-blocked, and non-JPEG frames are never sent');
    assert.ok(warns.some((w) => /512KB/.test(w.what)));
    assert.ok(warns.some((w) => /off-limits/.test(w.what)));
    assert.ok(warns.some((w) => /non-JPEG/.test(w.what)));

    // 3. Gemini toolCall -> Orbit function_call_arguments.done -> Orbit function_call_output -> Gemini toolResponse with tracked name.
    fake.sendToolCall({ id: 'call_abc', name: 'list_sessions', args: { limit: 3 } });
    await until(() => ev.some((e) => e.type === 'response.function_call_arguments.done'));
    const fcEv = ev.find((e) => e.type === 'response.function_call_arguments.done');
    assert.equal(fcEv.call_id, 'call_abc');
    assert.equal(fcEv.name, 'list_sessions');
    assert.deepEqual(JSON.parse(fcEv.arguments), { limit: 3 });

    sock.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_abc', output: JSON.stringify({ sessions: ['main'] }) },
    }));
    sock.send(JSON.stringify({ type: 'response.create' })); // should NOT send redundant clientContent
    await until(() => fake.received.length === 6);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fake.received.length, 6, 'no redundant clientContent after toolResponse');
    assert.deepEqual(fake.received[5].toolResponse.functionResponses, [
      { id: 'call_abc', name: 'list_sessions', response: { sessions: ['main'] } },
    ]);

    // 4. Gemini audio reply (16kHz -> resampled to 24kHz) + input/output transcriptions + turnComplete.
    const pcm16Out = Buffer.alloc(1600 * 2, 0x22);
    fake.sendAudioReply({
      pcm: pcm16Out,
      rate: 16000,
      inputTranscript: 'List my sessions',
      transcript: 'You have one session.',
    });
    await until(() => ev.filter((e) => e.type === 'response.done').length === 2);
    const inTrans = ev.find((e) => e.type === 'conversation.item.input_audio_transcription.completed');
    assert.equal(inTrans.transcript, 'List my sessions');
    const outAudio = ev.find((e) => e.type === 'response.output_audio.delta');
    assert.equal(Buffer.from(outAudio.delta, 'base64').length, 2400 * 2, '16kHz output resampled to 24kHz');
    const outTrans = ev.filter((e) => e.type === 'response.output_audio_transcript.done').at(-1);
    assert.equal(outTrans.transcript, 'You have one session.');

    // 5. Gemini barge-in (`interrupted`) cancels active turn.
    fake.sendAudioReply({ transcript: 'Starting...', turnComplete: false });
    await until(() => ev.filter((e) => e.type === 'response.created').length === 3);
    fake.sendInterrupted();
    await until(() => ev.filter((e) => e.type === 'response.done').length === 3);
    assert.equal(ev.filter((e) => e.type === 'response.done').at(-1).response.status, 'cancelled');

    // 6. Orbit `response.cancel` cancels active turn and drops residual chunks until turnComplete.
    fake.sendAudioReply({ transcript: 'Another reply', turnComplete: false });
    await until(() => ev.filter((e) => e.type === 'response.created').length === 4);
    const audioCountBeforeCancel = ev.filter((e) => e.type === 'response.output_audio.delta').length;
    sock.send(JSON.stringify({ type: 'response.cancel' }));
    await until(() => ev.filter((e) => e.type === 'response.done').length === 4);
    assert.equal(ev.filter((e) => e.type === 'response.done').at(-1).response.status, 'cancelled');
    fake.sendAudioReply({ transcript: 'late chunk', turnComplete: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ev.filter((e) => e.type === 'response.output_audio.delta').length, audioCountBeforeCancel, 'residual audio dropped after cancel');

    const closed = new Promise((r) => sock.once('close', (code) => r(code)));
    sock.close();
    assert.equal(await closed, 1000);
  } finally {
    await fake.close();
  }
});
