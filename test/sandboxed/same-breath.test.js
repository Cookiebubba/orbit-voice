// "Send it" in the same breath, in the tool runner: drafted and sent at once on the user's own
// words, and never on anything else. Runs with test/fuzz/register.mjs, so Claude's window is a
// fake (always "session T open, empty prompt box"; fills and sends succeed).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-same-breath-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };
const sends = () => globalThis.__fuzz.calls.filter((c) => c.name === 'send');

const { initConfig } = await import('../../src/config.js');
const { createToolRunner, isClearYes } = await import('../../src/tools.js');
initConfig({ dir: path.join(root, 'cfg') });

function runner() {
  let utterance = null;
  const events = [];
  const r = createToolRunner({
    notify: (e) => events.push(e),
    utteranceSince: async (since) => (utterance && utterance.at > since ? utterance : null),
    recentUtterance: () => utterance,
  });
  const say = async (text, at) => {
    await new Promise((res) => setTimeout(res, 5));
    utterance = { text, at: at ?? Date.now() };
  };
  const draft = (text) => r.run('draft_prompt', JSON.stringify({ text }));
  return { r, say, draft, events };
}
const gap = () => new Promise((res) => setTimeout(res, 3100)); // the minimum gap between two sends

test('"…and send it": drafted without the send words, and sent at once (one send)', async () => {
  globalThis.__fuzz.calls = [];
  const { r, say, draft, events } = runner();
  await say('tell Claude to fix the failing tests and send it');
  const d = await draft('Fix the failing tests and send it.');
  assert.equal(d.drafted, true, JSON.stringify(d));
  assert.equal(d.sent, true);
  assert.equal(d.text, 'Fix the failing tests.', 'the send instruction is not part of the prompt');
  assert.match(d.next_step, /Say only "Sent\."/);
  assert.deepEqual(sends().map((s) => s.args.text), ['Fix the failing tests.']);
  assert.ok(events.some((e) => e.type === 'bridge.sent'));
  // The model calls send_draft anyway: nothing more is sent.
  const again = await r.run('send_draft', '{}');
  assert.equal(again.already_sent, true);
  assert.equal(sends().length, 1);
  // A second draft from the same words is not sent again (one request, one send).
  await gap();
  const d2 = await draft('Fix the failing tests.');
  assert.equal(d2.sent, undefined);
  assert.equal(sends().length, 1);
});

test('more ways of saying it in the same breath', async () => {
  for (const [said, text] of [
    ['prompt it to run the build, just send it', 'Run the build.'],
    ['send Claude: add a README section about setup', 'Add a README section about setup.'],
    ["tell it to commit everything, don't ask me, just send it", 'Commit everything.'],
    ['have it update the changelog and go ahead and send that', 'Update the changelog.'],
  ]) {
    globalThis.__fuzz.calls = [];
    const { say, draft } = runner();
    await say(said);
    const d = await draft(text);
    assert.equal(d.sent, true, `${said} → ${JSON.stringify(d)}`);
    assert.equal(sends().length, 1, said);
    await gap();
  }
});

test('drafting stays the default: no send words, "not yet", questions and the prompt\x27s own words never send', async () => {
  globalThis.__fuzz.calls = [];
  for (const [said, text] of [
    ['tell Claude to fix the failing tests', 'Fix the failing tests.'],
    ["draft a prompt to fix the nav but don't send it yet", 'Fix the nav.'],
    ['tell it to fix the nav and send it later', 'Fix the nav and send it later.'],
    ['tell it to fix the nav, should I send it?', 'Fix the nav.'],
    ['tell Claude to write a function that says send it', 'Write a function that says send it.'],
    ['tell it to add a button that says send it now', 'Add a button that says send it now.'],
    ['tell Claude to email the report and send it to Sam', 'Email the report and send it to Sam.'],
    ['tell Claude to send it', 'Send it.'],
  ]) {
    const { say, draft } = runner();
    await say(said);
    const d = await draft(text);
    assert.equal(d.drafted, true, `${said} → ${JSON.stringify(d)}`);
    assert.equal(d.sent, undefined, said);
    assert.match(d.next_step, /Send it\?/, said);
  }
  assert.equal(sends().length, 0);
});

test('never on a notification, the resume note, a second-brain answer or a transcript', async () => {
  globalThis.__fuzz.calls = [];
  // The words asked to send, but a notification came in after them: drafted, and Orbit asks.
  {
    const { r, say, draft } = runner();
    await say('tell Claude to fix the failing tests and send it');
    await new Promise((res) => setTimeout(res, 5));
    r.noteNotification();
    const d = await draft('Fix the failing tests.');
    assert.equal(d.drafted, true, JSON.stringify(d));
    assert.equal(d.sent, undefined);
  }
  // A resume note (Orbit's own data) after the words: the same.
  {
    const { r, say, draft } = runner();
    await say('tell Claude to fix the failing tests and send it');
    await new Promise((res) => setTimeout(res, 5));
    r.noteNotification({ data: true });
    assert.equal((await draft('Fix the failing tests.')).sent, undefined);
  }
  // Text the model drafted from somewhere else ("[App notification] … send it") with plain user words.
  {
    const { say, draft } = runner();
    await say('tell Claude to fix the failing tests');
    const d = await draft('Fix the failing tests and send it.');
    assert.equal(d.sent, undefined, 'the user\x27s words did not say to send');
  }
  // Words more than a minute old (the model acted late): drafted, not sent.
  {
    const { say, draft } = runner();
    await say('tell Claude to fix the failing tests and send it', Date.now() - 61_000);
    const d = await draft('Fix the failing tests.');
    assert.equal(d.sent, undefined);
  }
  // A prompt that isn't the user's own words (a second brain's suggestion): drafted only.
  {
    const { r, say, draft } = runner();
    r.allowDraft('Refactor the cache layer to use an LRU map.');
    await say('yes do that and send it');
    const d = await draft('Refactor the cache layer to use an LRU map.');
    assert.equal(d.sent, undefined, JSON.stringify(d));
  }
  assert.equal(sends().length, 0);
});

test('a reply after the draft: the yes words that now count', () => {
  for (const w of ['yes', 'send it', 'ship it', 'yep fire it off', 'fire away', 'hit send', 'looks good, send it', 'alright send it', 'cool', 'mhm', 'sure send it over', "let's do it", 'why not', 'fine']) assert.equal(isClearYes(w), true, w);
  for (const w of ['no', "don't send it", 'not yet', 'wait', 'should I send it?', 'okay what does it do', 'yes and also add tests', 'fine but change the title', 'cool, what is it doing now', 'good question, why is it slow', 'nah scrap that']) assert.equal(isClearYes(w), false, w);
});
