// Spoken updates while asleep ("announce wake"), checked at the bridge: Grok says what Claude
// finished with no mic audio forwarded, the mic is only forwarded in a short window after that,
// silence hangs up, and speech carries on as a normal conversation. Grok is a local fake; Claude's
// window is the fuzzer's fake (test/fuzz/register.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-announce-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };

const PORT = 4396;
const host = `127.0.0.1:${PORT}`;
const origin = `http://${host}`;

// Fake Grok: records what it receives; `onNotice` decides how it answers an app notification.
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => fake.on('listening', r));
process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;
let upstream = null; // { sock, got: [{ type, at }] }
let onNotice = (sock) => speak(sock);
let connections = 0;
fake.on('connection', (sock) => {
  connections++;
  const u = { sock, got: [] };
  upstream = u;
  sock.on('message', (m) => {
    const msg = JSON.parse(String(m));
    u.got.push({ ...msg, at: Date.now() });
    if (msg.type === 'conversation.item.create' && /\[App notification\]/.test(JSON.stringify(msg))) onNotice(sock);
  });
});
const send = (sock, e) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(e));
function speak(sock) {
  send(sock, { type: 'response.created' });
  send(sock, { type: 'response.output_audio.delta', delta: Buffer.alloc(480).toString('base64') });
  send(sock, { type: 'response.done' });
}

// Fake session watcher, so a test can say "Claude finished".
const listeners = new Set();
const watcher = { on: (fn) => listeners.add(fn), start() {}, working: () => [] };
const finished = (title) => listeners.forEach((fn) => fn({ type: 'claude.finished', id: title, title, summary: '' }));

const { updateSettings } = await import('../../src/config.js');
const server = await import('../../src/server.js');
server.ANNOUNCE_TIMING.listenMs = 300;
server.ANNOUNCE_TIMING.slackMs = 200;
// These tests wake Grok back to back: no spacing or hourly cap here (tested on their own below).
Object.assign(server.WAKE_LIMITS, { gapMs: 0, perHour: 1000, sessionCooldownMs: 0 });
const mem = (v) => ({ kind: 'memory', get: () => v, set: (x) => (v = x) });
await server.startServer({ port: PORT, configDir: path.join(root, 'cfg'), secrets: mem('xai-' + 'k'.repeat(40)), brainSecrets: mem(''), clipboard: () => {}, models: root, watcher });

const cookie = await new Promise((resolve) => {
  const u = new URL(server.authUrl());
  http.get({ host: '127.0.0.1', port: PORT, path: u.pathname + u.search, headers: { host } }, (res) => resolve(String(res.headers['set-cookie'][0]).split(';')[0]));
});

/** Open a page connection; resolves once the bridge says it's ready. */
async function page({ announce = true } = {}) {
  const ws = new WebSocket(`ws://${host}/voice${announce ? "?announce=1" : ""}`, { headers: { origin, cookie } });
  const events = [];
  const waiters = [];
  ws.on('message', (m) => {
    const e = JSON.parse(String(m));
    events.push(e);
    for (const w of [...waiters]) if (w.test(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
  });
  const closed = new Promise((r) => ws.on('close', r));
  const next = (type, ms = 3000) =>
    new Promise((resolve, reject) => {
      const hit = events.find((e) => e.type === type);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`no ${type} within ${ms}ms`)), ms);
      waiters.push({ test: (e) => e.type === type, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  const msg = (o) => ws.send(JSON.stringify(o));
  const mic = () => msg({ type: 'input_audio_buffer.append', audio: Buffer.alloc(96).toString('base64') });
  // Ready, or refused before Grok was even contacted.
  await Promise.race([next('bridge.ready'), closed]);
  return { ws, events, next, msg, mic, closed };
}
const appendsAt = () => (upstream?.got || []).filter((g) => g.type === 'input_audio_buffer.append').map((g) => g.at);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a spoken update keeps the mic closed until Grok has spoken, listens briefly, then hangs up', async () => {
  updateSettings({ announce: 'speak', announceWake: true });
  finished('Fix the login bug');
  let speakNow;
  onNotice = (sock) => (speakNow = () => speak(sock)); // Grok answers when the test says so
  const p = await page();
  p.mic(); // before announcing: dropped
  assert.equal((await p.next('bridge.announce')).ok, true);
  await wait(50);
  const notice = upstream.got.find((g) => g.type === 'conversation.item.create');
  assert.match(JSON.stringify(notice), /Fix the login bug/);
  p.mic();
  p.msg({ type: 'ui.listen_window' }); // too early: Grok hasn't spoken yet
  p.mic();
  await wait(50);
  assert.equal(appendsAt().length, 0, 'no mic audio before Grok has spoken');
  speakNow();
  await p.next('bridge.announce_ready');
  p.mic(); // ready, but the page hasn't opened its window yet
  await wait(30);
  assert.equal(appendsAt().length, 0, 'no mic audio before the listening window');
  const opened = Date.now();
  p.msg({ type: 'ui.listen_window' });
  p.mic();
  await wait(50);
  assert.equal(appendsAt().length, 1, 'mic audio flows in the window');
  await p.closed; // nothing said: the bridge hangs up
  const took = Date.now() - opened;
  assert.ok(took >= 450 && took < 1500, `hung up after ${took}ms`);
  assert.equal(p.events.find((e) => e.type === 'bridge.announce' && e.ok === false)?.reason, 'no reply');
  assert.ok(appendsAt().every((at) => at - opened < 600), 'nothing forwarded after the window');
});

test('words in the window carry on as a normal conversation, which hangs up when it goes quiet', async () => {
  await wait(100); // let the previous connection finish closing on the bridge's side
  finished('Write the docs');
  onNotice = (sock) => speak(sock);
  const p = await page();
  await p.next('bridge.announce_ready');
  p.msg({ type: 'ui.listen_window' });
  await wait(30);
  send(upstream.sock, { type: 'input_audio_buffer.speech_started', item_id: 'a1' });
  await p.next('input_audio_buffer.speech_started');
  await wait(700); // well past the window, but speech started inside it: still listening for words
  p.mic();
  await wait(50);
  assert.equal(appendsAt().length, 1, 'forwarded while that speech is transcribed');
  send(upstream.sock, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a1', transcript: 'Tell Claude to add tests.' });
  await p.next('conversation.item.input_audio_transcription.completed');
  server.ANNOUNCE_TIMING.idleMs = 400; // short, so the test can see it
  await wait(100);
  p.mic();
  await wait(50);
  assert.equal(p.ws.readyState, WebSocket.OPEN, 'still connected after the window and the heard cap');
  assert.equal(appendsAt().length, 2, 'the mic is forwarded as usual');
  send(upstream.sock, { type: 'response.created' }); // Grok answers: keeps it alive
  send(upstream.sock, { type: 'response.done' });
  await p.closed; // then nothing for idleMs: hung up
  assert.equal(p.events.find((e) => e.type === 'bridge.announce' && e.ok === false)?.reason, 'quiet');
  server.ANNOUNCE_TIMING.idleMs = 75_000;
});

test('a cough in the window (speech that never becomes words) does not keep the mic open', async () => {
  await wait(100);
  finished('Bump the version');
  onNotice = (sock) => speak(sock);
  server.ANNOUNCE_TIMING.heardMs = 400;
  const p = await page();
  await p.next('bridge.announce_ready');
  p.msg({ type: 'ui.listen_window' });
  await wait(30);
  const heardAt = Date.now();
  send(upstream.sock, { type: 'input_audio_buffer.speech_started', item_id: 'c1' });
  send(upstream.sock, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'c1', transcript: ' ... ' });
  await p.closed;
  const took = Date.now() - heardAt;
  assert.ok(took >= 350 && took < 1200, `hung up ${took}ms after the cough`);
  assert.equal(p.events.find((e) => e.type === 'bridge.announce' && e.ok === false)?.reason, 'no words');
  server.ANNOUNCE_TIMING.heardMs = 8000;
});

test('speech events while the mic is closed are dropped, and a second update closes the window again', async () => {
  await wait(100);
  finished('Refactor the parser');
  onNotice = (sock) => speak(sock);
  const p = await page();
  await p.next('bridge.announce');
  // Grok "hears" something although no audio was sent: not passed on, not an answer.
  send(upstream.sock, { type: 'input_audio_buffer.speech_started', item_id: 'x' });
  send(upstream.sock, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'x', transcript: 'yes send it' });
  await p.next('bridge.announce_ready');
  assert.equal(p.events.some((e) => e.type === 'input_audio_buffer.speech_started' || e.type.startsWith('conversation.item.input_audio')), false);
  p.msg({ type: 'ui.listen_window' });
  await wait(20);
  send(upstream.sock, { type: 'response.created' }); // another update starts: mic closed again
  await wait(30);
  p.mic();
  await wait(50);
  assert.equal(appendsAt().length, 0);
  p.ws.close();
  await p.closed;
});

test('a spoken update hangs up when the setting is off or there is nothing new; ordinary conversations are untouched', async () => {
  await wait(100);
  updateSettings({ announceWake: false });
  finished('Ship it');
  const grokBefore = connections;
  let p = await page();
  assert.equal((await p.next('bridge.announce')).ok, false);
  await p.closed;
  assert.equal(connections, grokBefore, 'refused without contacting Grok (nothing billed)');

  updateSettings({ announceWake: true });
  p = await page(); // 'Ship it' is still unspoken: allowed now
  assert.equal((await p.next('bridge.announce')).ok, true);
  p.ws.close();
  await p.closed;

  const grokBefore2 = connections;
  p = await page(); // everything has been said
  assert.equal((await p.next('bridge.announce')).reason, 'nothing to say');
  await p.closed;
  assert.equal(connections, grokBefore2);

  // An ordinary conversation: the mic flows from the start, and an update is just spoken in it.
  p = await page({ announce: false });
  p.mic();
  await wait(50);
  assert.equal(appendsAt().length, 1);
  finished('Late one');
  await wait(50);
  assert.match(JSON.stringify(upstream.got.filter((g) => g.type === 'conversation.item.create')), /Late one/);
  assert.equal(p.events.some((e) => e.type === 'bridge.announce'), false);
  p.ws.close();
  await p.closed;
});

test.after(() => {
  fake.close();
  setTimeout(() => process.exit(0), 50).unref();
});
