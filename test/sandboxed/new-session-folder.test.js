// A new session always gets a project folder: the one named, else the one used last, else Orbit
// asks which (and the answer, naming one, starts it there). Runs with test/fuzz/register.mjs:
// Claude's window is a fake (its answers picked by index below), nothing real is pressed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-new-folder-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');

// newSession's answers (test/fuzz/fake-desktop.mjs): 0 = created in a folder, 1 = open with no folder.
const queue = [];
let nextLen = 7;
globalThis.__fuzz = { rng: () => ((queue.length ? queue.shift() : 0) + 0.5) / nextLen, str: () => 'beta', calls: [], windowTitle: () => 'T' };
const calls = globalThis.__fuzz.calls;
const origPush = calls.push.bind(calls);
calls.push = (c) => ((nextLen = { info: 7, new: 6, send: 3 }[c.name] || 3), origPush(c));
const news = () => calls.filter((c) => c.name === 'new').map((c) => c.args.project);

const { initConfig } = await import('../../src/config.js');
const { createToolRunner } = await import('../../src/tools.js');
initConfig({ dir: path.join(root, 'cfg') });

function runner() {
  let utterance = null;
  const r = createToolRunner({ notify: () => {}, utteranceSince: async (s) => (utterance && utterance.at > s ? utterance : null), recentUtterance: () => utterance });
  const say = async (text) => {
    await new Promise((res) => setTimeout(res, 3));
    utterance = { text, at: Date.now() };
  };
  return { r, say };
}

test('no folder named and none used before: the session opens, and Orbit asks which, naming them', async () => {
  calls.length = 0;
  const { r, say } = runner();
  await say('start a new thread');
  queue.push(1); // Claude's New: open, no folder chosen
  const a = await r.run('new_session', '{}');
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.folder, null);
  assert.deepEqual(a.folders, ['alpha', 'beta'], 'the folders Claude lists');
  assert.match(a.next_step, /which folder/);
  // Words that don't name a folder don't start anything.
  await say('hmm');
  assert.equal((await r.run('new_session', JSON.stringify({ project: 'beta' }))).ok, false);
  // Their answer naming one starts it there.
  await say('the beta one');
  queue.push(0);
  const b = await r.run('new_session', JSON.stringify({ project: 'beta' }));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.folder, 'beta');
  assert.deepEqual(news(), ['', 'beta']);
});

test('no folder named: the folder used last', async () => {
  calls.length = 0;
  // A session on disk, last used in ...\work\alpha\api (Claude's sidebar lists "alpha").
  const dir = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_one.json'), JSON.stringify({ sessionId: 'local_one', cliSessionId: 'one', title: 'API work', cwd: path.join(root, 'work', 'alpha', 'api'), lastFocusedAt: Date.now(), createdAt: Date.now() }));
  const { r, say } = runner();
  await say('new session please');
  queue.push(0);
  const a = await r.run('new_session', '{}');
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(news(), ['alpha'], 'Claude\x27s "New session in alpha"');
});
