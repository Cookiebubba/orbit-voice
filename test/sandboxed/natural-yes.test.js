// Sending on a natural yes (src/consent.js): after Orbit says the draft is in the box, any clear yes
// in the user's own words sends it, with extra words or speech-to-text slop; a no, a "wait", a
// question or a change never does, and neither does anything that isn't the user's own reply.
// Runs with test/fuzz/register.mjs: Claude's window is a fake (fills and sends succeed).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-natural-yes-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };
const sends = () => globalThis.__fuzz.calls.filter((c) => c.name === 'send');

const { initConfig } = await import('../../src/config.js');
const { createToolRunner } = await import('../../src/tools.js');
const { consentOf, isClearYes } = await import('../../src/consent.js');
initConfig({ dir: path.join(root, 'cfg') });

function runner() {
  let utterance = null;
  const replies = [];
  const r = createToolRunner({
    notify: () => {},
    utteranceSince: async (since) => (utterance && utterance.at > since ? utterance : null),
    recentUtterance: () => utterance,
    userWords: () => replies.map((x) => x.text).join(' '),
    repliesSince: (ts) => replies.filter((x) => x.at > ts).length,
  });
  const say = async (text) => {
    await new Promise((res) => setTimeout(res, 5));
    utterance = { text, at: Date.now() };
    replies.push(utterance);
  };
  return { r, say };
}
const gap = () => new Promise((res) => setTimeout(res, 3100)); // the minimum gap between two sends

const YES = [
  'yeah', 'yes', 'yep', 'sure', 'do it', 'go', 'go for it', 'sounds good', 'looks good', 'perfect', 'ok send', "that's good",
  'great', 'ship it', 'mhm', 'Mm-hmm.', 'uh huh', 'yeah that looks good, send it over', 'Yes please.', 'why not',
  'can you send it?', 'could you just press send', 'yeah can you send that to Claude?', 'the send button is there now, look for it and press it',
  'sent it', 'Sendit.', 'yeah, go ahead', 'perfect, thanks', 'good idea, do that', 'yeah yeah', 'absolutely, ship it', 'lgtm',
];
const NO = [
  'no', 'nope', "don't send it", 'not yet', 'wait', 'hold on', 'hang on a sec', 'what does it say?', 'should I send it?', 'is it in the box?',
  'change it to say hello', 'make it shorter', 'yes and also add tests', 'fine but change the title', 'send it, um, add to that draft',
  'maybe', 'hmm', 'let me think', 'actually no', 'never mind', 'yeah add tests', "I don't know", 'go to sleep', 'send it to Sam',
  'yeah I think the login page is broken and the database layer needs a look too', 'copy that draft to my clipboard', '',
];

test('the scorer: clear yeses in many forms, and every no, wait, question and change', () => {
  for (const w of YES) assert.equal(isClearYes(w), true, `yes: ${w} (${consentOf(w).why})`);
  for (const w of NO) assert.equal(isClearYes(w), false, `no: ${w} (${consentOf(w).why})`);
  assert.equal(consentOf('make it shorter').why, 'change');
  assert.equal(consentOf('what does it say?').why, 'question');
  assert.equal(consentOf('wait').why, 'negation');
});

test('send_draft: a natural yes after the draft sends it (no exact words needed)', async () => {
  for (const reply of ['yeah that looks good', 'sure', 'mhm', 'go for it']) {
    globalThis.__fuzz.calls = [];
    const { r, say } = runner();
    await say('tell Claude to add a retry to the upload');
    const d = await r.run('draft_prompt', JSON.stringify({ text: 'Add a retry to the upload.' }));
    assert.equal(d.drafted, true, JSON.stringify(d));
    assert.doesNotMatch(d.next_step, /say "?yes, send it/i, 'never coaches exact words');
    await say(reply);
    const s = await r.run('send_draft', '{}');
    assert.notEqual(s.ok, false, `${reply}: ${JSON.stringify(s)}`);
    assert.equal(sends().length, 1, reply);
    await gap();
  }
});

test('send_draft: no, wait, a question or a change never sends, and the error never coaches words', async () => {
  for (const reply of ['wait', 'not yet', 'what does it say?', 'make it shorter', 'no']) {
    globalThis.__fuzz.calls = [];
    const { r, say } = runner();
    await say('tell Claude to add a retry to the upload');
    await r.run('draft_prompt', JSON.stringify({ text: 'Add a retry to the upload.' }));
    await say(reply);
    const s = await r.run('send_draft', '{}');
    assert.equal(s.ok, false, reply);
    assert.doesNotMatch(`${s.error} ${s.next_step}`, /say "?yes, send it|say "send it"/i, 'never coaches exact words');
    assert.equal(sends().length, 0, reply);
  }
});

test('send_draft: only the user\x27s own reply right after the draft counts', async () => {
  globalThis.__fuzz.calls = [];
  // No reply at all (the model decides alone): not sent.
  let { r, say } = runner();
  await say('tell Claude to add a retry to the upload');
  await r.run('draft_prompt', JSON.stringify({ text: 'Add a retry to the upload.' }));
  assert.equal((await r.run('send_draft', '{}')).ok, false);
  // A yes said before the draft appeared doesn't count for it.
  ({ r, say } = runner());
  await say('yeah tell Claude to add a retry to the upload');
  await r.run('draft_prompt', JSON.stringify({ text: 'Add a retry to the upload.' }));
  assert.equal((await r.run('send_draft', '{}')).ok, false);
  // A notification after the draft (a session finished): a yes may be about that instead.
  ({ r, say } = runner());
  await say('tell Claude to add a retry to the upload');
  await r.run('draft_prompt', JSON.stringify({ text: 'Add a retry to the upload.' }));
  await new Promise((res) => setTimeout(res, 5));
  r.noteNotification();
  await say('yeah');
  assert.equal((await r.run('send_draft', '{}')).ok, false);
  // The talk moved on (a third reply since the draft): the yes may be to something else.
  ({ r, say } = runner());
  await say('tell Claude to add a retry to the upload');
  await r.run('draft_prompt', JSON.stringify({ text: 'Add a retry to the upload.' }));
  await say('what time is it in Tokyo');
  await say('and in London?');
  await say('yeah');
  const s = await r.run('send_draft', '{}');
  assert.equal(s.ok, false);
  assert.match(s.error, /moved on/);
  assert.equal(sends().length, 0);
});
