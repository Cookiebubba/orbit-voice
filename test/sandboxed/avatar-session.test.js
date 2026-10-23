// The avatar in a live call, checked at the bridge with a fake Grok (synthetic words only):
//   - the fast path: a finished transcript that is only an avatar command runs it at once; Grok's
//     own response to those words is cancelled and none of it (audio, captions, tool calls) reaches
//     the page or runs, whether it started before the transcript or after; anything else is left alone
//   - the `avatar` tool, offered only while an avatar is on
// Claude's window and `claude` are the fuzzer's fakes (test/fuzz/register.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-avatar-session-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };

const PORT = 4394;
const host = `127.0.0.1:${PORT}`;
const origin = `http://${host}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Grok: records what it gets; the test sends its events by hand ----
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => fake.on('listening', r));
process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;
let up = null; // { sock, got }
const conns = [];
fake.on('connection', (sock) => {
  up = { sock, got: [] };
  conns.push(up);
  const mine = up;
  sock.on('message', (m) => mine.got.push(JSON.parse(String(m))));
});
const grok = (e) => up.sock.readyState === WebSocket.OPEN && up.sock.send(JSON.stringify(e));
const got = (type) => up.got.filter((g) => g.type === type);

// ---- the avatar on screen (the desktop shell's sink) ----
const { updateSettings } = await import('../../src/config.js');
const avatarCommands = await import('../../src/avatar-commands.js');
let sinkResult = { ok: true };
const ran = [];
avatarCommands.setAvatarSink((c) => (ran.push(c), sinkResult));

const listeners = new Set();
const watcher = { on: (fn) => listeners.add(fn), start() {}, working: () => [] };
const server = await import('../../src/server.js');
const tools = await import('../../src/tools.js');
Object.assign(tools.TOOL_TIMING, { openSessionWaitMs: 0, newSessionWaitMs: 0 });
const mem = (v) => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
await server.startServer({ port: PORT, configDir: path.join(root, 'cfg'), secrets: mem('xai-' + 'k'.repeat(40)), brainSecrets: mem(''), clipboard: () => {}, models: root, watcher });
updateSettings({ avatar: 'qubit', announce: 'chime', brainEnabled: false });

const cookie = await new Promise((resolve) => {
  const u = new URL(server.authUrl());
  http.get({ host: '127.0.0.1', port: PORT, path: u.pathname + u.search, headers: { host } }, (res) => resolve(String(res.headers['set-cookie'][0]).split(';')[0]));
});

async function page() {
  const ws = new WebSocket(`ws://${host}/voice`, { headers: { origin, cookie } });
  const events = [];
  ws.on('message', (m) => events.push(JSON.parse(String(m))));
  const closed = new Promise((r) => ws.on('close', r));
  for (let i = 0; i < 300 && !events.some((e) => e.type === 'bridge.ready'); i++) await wait(10);
  await wait(50);
  return {
    ws,
    events,
    closed,
    async bye() {
      ws.close();
      await closed;
      await wait(60);
    },
  };
}
const audio = (rid) => ({ type: 'response.output_audio.delta', response_id: rid, item_id: `${rid}_a`, delta: Buffer.alloc(480).toString('base64') });
const sinceIdx = (p, n) => p.events.slice(n);

test('fast path, Grok already answering: the command runs, and nothing more of the answer reaches the page or runs', async () => {
  avatarCommands.resetAvatarRuns();
  ran.length = 0;
  const p = await page();
  const before = up.got.length;
  grok({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  await wait(10);
  grok({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  grok({ type: 'response.created', response: { id: 'r1' } });
  grok(audio('r1')); // "Sure..." (before the transcript): the page gets this one, then stops playing
  await wait(30);
  const n = p.events.length;
  grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Um, hey Qubit, do a backflip!' });
  await wait(40);
  assert.deepEqual(ran, [{ action: 'backflip' }], 'the backflip ran at once');
  assert.ok(up.got.slice(before).some((g) => g.type === 'response.cancel'), 'Grok was asked to cancel');
  const note = up.got.slice(before).find((g) => g.type === 'conversation.item.create' && /^\[Orbit note: .*Qubit.*a backflip/.test(g.item?.content?.[0]?.text || ''));
  assert.ok(note, 'Grok gets a quiet note');
  assert.equal(got('response.create').length, 0, '...with no response asked for');
  assert.ok(p.events.some((e) => e.type === 'bridge.avatar' && e.action === 'backflip' && e.fast), 'the page is told (it stops playback)');
  // Grok ignores the cancel and carries on: more audio, its words, a tool call, done.
  grok(audio('r1'));
  grok({ type: 'response.output_audio_transcript.done', response_id: 'r1', transcript: 'Watch this!' });
  grok({ type: 'response.function_call_arguments.done', response_id: 'r1', call_id: 'c1', name: 'go_to_sleep', arguments: '{}' });
  grok({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  await wait(80);
  const after = sinceIdx(p, n);
  assert.ok(!after.some((e) => e.type === 'response.output_audio.delta' || e.type === 'response.output_audio_transcript.done'), 'no more audio or captions');
  assert.ok(!after.some((e) => e.type === 'bridge.sleep' || e.type === 'bridge.tool'), 'its tool call never ran');
  assert.ok(after.some((e) => e.type === 'response.done'), 'the page still hears the response ended (it stops "thinking")');
  const out = up.got.find((g) => g.type === 'conversation.item.create' && g.item?.call_id === 'c1');
  assert.equal(JSON.parse(out.item.output).skipped, true, 'the call is answered as skipped');
  assert.equal(got('response.create').length, 0, 'and nothing asks Grok to go on');
  await p.bye();
});

test('fast path, transcript first: the response that follows is dropped as it starts', async () => {
  avatarCommands.resetAvatarRuns();
  ran.length = 0;
  const p = await page();
  grok({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
  await wait(10);
  grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'qubit roll left please' });
  await wait(30);
  assert.deepEqual(ran, [{ action: 'roll', dir: 'left' }]);
  const n = p.events.length;
  const cancels = got('response.cancel').length;
  grok({ type: 'response.created', response: { id: 'r2' } });
  grok(audio('r2'));
  grok({ type: 'response.done', response: { id: 'r2' } });
  await wait(60);
  assert.equal(got('response.cancel').length, cancels + 1, 'cancelled as it started');
  assert.ok(!sinceIdx(p, n).some((e) => e.type === 'response.output_audio.delta'));
  // The next thing the user says is answered as usual.
  grok({ type: 'input_audio_buffer.speech_started', item_id: 'u3' });
  await wait(10);
  grok({ type: 'response.created', response: { id: 'r3' } });
  grok(audio('r3'));
  grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u3', transcript: 'what is Claude doing' });
  grok(audio('r3'));
  grok({ type: 'response.done', response: { id: 'r3' } });
  await wait(60);
  assert.equal(sinceIdx(p, n).filter((e) => e.type === 'response.output_audio.delta' && e.response_id === 'r3').length, 2);
  assert.equal(ran.length, 1);
  await p.bye();
});

test('fast path: anything else is the model\x27s (no cancel, nothing run), and a refused cancel is no error', async () => {
  avatarCommands.resetAvatarRuns();
  ran.length = 0;
  const p = await page();
  const cancels = got('response.cancel').length;
  for (const [i, words] of ['tell Claude to add a backflip animation', 'can he do a backflip', 'go to sleep after you send it', 'do a dunce'].entries()) {
    grok({ type: 'input_audio_buffer.speech_started', item_id: `n${i}` });
    await wait(5);
    grok({ type: 'response.created', response: { id: `rn${i}` } });
    grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: `n${i}`, transcript: words });
    grok(audio(`rn${i}`));
    grok({ type: 'response.done', response: { id: `rn${i}` } });
    await wait(40);
  }
  assert.equal(got('response.cancel').length, cancels);
  assert.deepEqual(ran, []);
  assert.equal(p.events.filter((e) => e.type === 'response.output_audio.delta').length, 4);
  // xAI doesn't know response.cancel: its complaint never reaches the page.
  grok({ type: 'input_audio_buffer.speech_started', item_id: 'u9' });
  await wait(5);
  grok({ type: 'response.created', response: { id: 'r9' } });
  grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u9', transcript: 'jump' });
  await wait(20);
  grok({ type: 'error', error: { type: 'invalid_request_error', message: 'Unknown event type: response.cancel' } });
  grok({ type: 'response.done', response: { id: 'r9' } });
  await wait(40);
  assert.deepEqual(ran, [{ action: 'jump' }]);
  assert.ok(!p.events.some((e) => e.type === 'error'), 'no error caption');
  // A real error later still shows.
  await wait(2100);
  grok({ type: 'error', error: { type: 'server_error', message: 'Something else broke.' } });
  await wait(30);
  assert.ok(p.events.some((e) => e.type === 'error'));
  await p.bye();
});

test('fast path: not with no avatar, nor while it is off screen (the model says so instead)', async () => {
  avatarCommands.resetAvatarRuns();
  ran.length = 0;
  updateSettings({ avatar: 'none' });
  let p = await page();
  grok({ type: 'input_audio_buffer.speech_started', item_id: 'x1' });
  await wait(5);
  grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'x1', transcript: 'do a backflip' });
  await wait(40);
  assert.deepEqual(ran, []);
  assert.ok(!p.events.some((e) => e.type === 'bridge.avatar'));
  await p.bye();
  updateSettings({ avatar: 'qubit' });
  sinkResult = { ok: false, error: 'not on screen' };
  p = await page();
  const cancels = got('response.cancel').length;
  grok({ type: 'input_audio_buffer.speech_started', item_id: 'x2' });
  await wait(5);
  grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'x2', transcript: 'do a backflip' });
  await wait(40);
  assert.equal(ran.length, 1, 'tried');
  assert.equal(got('response.cancel').length, cancels, 'but Grok answers (it can say he is hidden)');
  assert.ok(!p.events.some((e) => e.type === 'bridge.avatar'));
  sinkResult = { ok: true };
  await p.bye();
});

test('the avatar tool: offered only while an avatar is on, and Grok\x27s call runs the command', async () => {
  avatarCommands.resetAvatarRuns();
  ran.length = 0;
  let p = await page();
  const cfg = got('session.update').at(-1).session;
  assert.ok(cfg.tools.some((t) => t.name === 'avatar'));
  grok({ type: 'response.created', response: { id: 'rt' } });
  grok({ type: 'response.function_call_arguments.done', response_id: 'rt', call_id: 'ct', name: 'avatar', arguments: JSON.stringify({ action: 'dance' }) });
  await wait(60);
  assert.deepEqual(ran, [{ action: 'dance' }]);
  const out = up.got.find((g) => g.item?.call_id === 'ct');
  assert.equal(JSON.parse(out.item.output).done, true);
  grok({ type: 'response.done', response: { id: 'rt' } });
  await p.bye();
  updateSettings({ avatar: 'none' });
  p = await page();
  assert.ok(!got('session.update').at(-1).session.tools.some((t) => t.name === 'avatar'));
  await p.bye();
  updateSettings({ avatar: 'qubit' });
});

test('switching avatars mid-call updates the live session: persona, body and tools, no restart', async () => {
  updateSettings({ avatar: 'qubit', showOrb: false });
  const p = await page();
  const conn = up;
  const cfg = () => got('session.update').at(-1).session;
  const updates = () => got('session.update').length;
  assert.match(cfg().instructions, /^Who you are:\n- You are Qubit/);
  assert.ok(!cfg().instructions.includes('You are Orbit'));
  assert.ok(!cfg().instructions.includes('The glowing orb'));
  let n = updates();
  updateSettings({ avatar: 'buddy' });
  await wait(30);
  assert.equal(updates(), n + 1, 'one session.update');
  assert.match(cfg().instructions, /^Who you are:\n- You are Buddy, the pixel buddy/);
  assert.ok(cfg().tools.find((t) => t.name === 'avatar').parameters.properties.action.enum.includes('wave'));
  n = updates();
  updateSettings({ avatar: 'none' });
  await wait(30);
  assert.equal(updates(), n + 1);
  assert.match(cfg().instructions, /^Who you are:\n- You are Orbit, the voice of the Orbit app/);
  assert.ok(!/Qubit|Buddy|Your body/.test(cfg().instructions));
  assert.ok(!cfg().tools.some((t) => t.name === 'avatar'));
  updateSettings({ avatar: 'qubit' });
  await wait(30);
  n = updates();
  updateSettings({ showOrb: true });
  await wait(30);
  assert.equal(updates(), n + 1, 'toggling the orb updates it too');
  assert.match(cfg().instructions, /You are Qubit[\s\S]*The glowing orb on screen is the Orbit app/);
  // The same call all along (no reconnect), and its job text unchanged.
  assert.equal(up, conn);
  assert.equal(conns.filter((c) => c.sock.readyState === WebSocket.OPEN).length, 1);
  assert.match(cfg().instructions, /Only call send_draft after the user clearly says yes in their latest reply/);
  await p.bye();
  // The next call starts with what's on screen now.
  updateSettings({ avatar: 'buddy', showOrb: false });
  const p2 = await page();
  assert.notEqual(up, conn);
  assert.match(got('session.update')[0].session.instructions, /^Who you are:\n- You are Buddy/);
  await p2.bye();
  updateSettings({ avatar: 'qubit', showOrb: true });
});

test.after(() => {
  fake.close();
  setTimeout(() => process.exit(0), 100).unref();
});

test('"go to sleep" hangs up at once: no model turn, no goodbye, whether or not an avatar is on', async () => {
  for (const avatar of ['qubit', 'none']) {
    updateSettings({ avatar });
    const p = await page();
    const before = up.got.length;
    grok({ type: 'input_audio_buffer.speech_started', item_id: `s-${avatar}` });
    await wait(10);
    grok({ type: 'response.created', response: { id: `rs-${avatar}` } });
    grok(audio(`rs-${avatar}`)); // Grok had started a goodbye before the transcript came in
    await wait(20);
    const n = p.events.length;
    grok({ type: 'conversation.item.input_audio_transcription.completed', item_id: `s-${avatar}`, transcript: 'Okay, go to sleep, thanks.' });
    await wait(60);
    assert.ok(sinceIdx(p, n).some((e) => e.type === 'bridge.sleep'), `${avatar}: the page is told to hang up now`);
    assert.ok(up.got.slice(before).some((g) => g.type === 'response.cancel'), `${avatar}: Grok's reply is cancelled`);
    grok(audio(`rs-${avatar}`));
    grok({ type: 'response.output_audio_transcript.done', response_id: `rs-${avatar}`, transcript: 'Goodnight!' });
    grok({ type: 'response.done', response: { id: `rs-${avatar}` } });
    await wait(60);
    assert.ok(!sinceIdx(p, n).some((e) => e.type === 'response.output_audio.delta' || e.type === 'response.output_audio_transcript.done'), `${avatar}: no goodbye reaches the page`);
    assert.equal(got('response.create').length, 0, `${avatar}: nothing asks Grok to speak`);
    await p.bye();
  }
  updateSettings({ avatar: 'qubit' });
});

test('emote cues: out of every transcript the page gets or Orbit keeps, and where each one was goes to the page', async () => {
  const p = await page();
  const n = p.events.length;
  grok({ type: 'response.created', response: { id: 'r7' } });
  // Split anywhere, even inside a cue: "<happy> Done! The tests pass. <curi" + "ous> Want me to <nod>send it?"
  const parts = ['<hap', 'py> Done! The tests pass. <curi', 'ous> Want me to <n', 'od>send it?'];
  for (const d of parts) grok({ type: 'response.output_audio_transcript.delta', response_id: 'r7', item_id: 'r7_a', delta: d });
  grok(audio('r7'));
  grok({ type: 'response.output_audio_transcript.done', response_id: 'r7', item_id: 'r7_a', transcript: parts.join('') });
  grok({ type: 'response.done', response: { id: 'r7', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: parts.join('') }] }] } });
  await wait(80);
  const after = sinceIdx(p, n);
  const deltas = after.filter((e) => e.type === 'response.output_audio_transcript.delta').map((e) => e.delta).join('');
  const clean = 'Done! The tests pass. Want me to send it?';
  assert.equal(deltas, clean, 'the captions as they come');
  assert.equal(after.find((e) => e.type === 'response.output_audio_transcript.done').transcript, clean, 'the whole caption');
  assert.equal(after.find((e) => e.type === 'response.done').response.output[0].content[0].transcript, clean, 'the finished reply');
  const emotes = after.filter((e) => e.type === 'bridge.emote');
  assert.deepEqual(emotes.map((e) => [e.cue, e.at, e.response_id]), [['happy', 0, 'r7'], ['curious', clean.indexOf('Want'), 'r7'], ['nod', clean.indexOf('send'), 'r7']]);
  assert.ok(!JSON.stringify(after.filter((e) => e.type !== 'bridge.emote')).match(/<|happy|curi|od>/), 'no trace of a cue anywhere else the page gets');
  await p.bye();
  // The resume note the next call starts with (what was said in this one): no cues either.
  const before = conns.length;
  const p2 = await page();
  assert.equal(conns.length, before + 1);
  const note = up.got.find((g) => g.type === 'conversation.item.create' && /Orbit resume note/.test(g.item?.content?.[0]?.text || ''));
  assert.ok(note && note.item.content[0].text.includes('Want me to send it?'), 'what was said is in the note');
  assert.ok(!/<(happy|curious|nod)>/.test(note.item.content[0].text), 'without its cues');
  await p2.bye();
});
