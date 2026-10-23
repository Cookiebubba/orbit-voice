// "Send it" in the same breath (src/send-intent.js): which words tell Orbit to send the prompt
// they ask for, and which never do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendInstruction, withoutSendTail } from '../src/send-intent.js';

const yes = [
  ['tell Claude to fix the tests and send it', 'tell Claude to fix the tests'],
  ['tell Claude to fix the tests, and send it.', 'tell Claude to fix the tests'],
  ['prompt it to run the build, just send it', 'prompt it to run the build'],
  ['have it update the changelog and go ahead and send that', 'have it update the changelog'],
  ['fix the typo in the footer and send', 'fix the typo in the footer'],
  ['tell it to commit everything, just send it, don\x27t ask me', 'tell it to commit everything'],
  ["tell it to commit everything, don't ask me, just send it", 'tell it to commit everything'],
  ['ask it why the build is slow and send it right away', 'ask it why the build is slow'],
  ['tell it to bump the version then send it', 'tell it to bump the version'],
  ['tell it to add tests and sent it', 'tell it to add tests'], // a mishearing of "send it"
  ['tell it to add tests and send it off', 'tell it to add tests'],
  ['tell it to add tests and send it over to Claude', 'tell it to add tests'],
  ['tell it to clean up the logs and fire it off', 'tell it to clean up the logs'],
  ['tell Claude to rerun the migration. Send it.', 'tell Claude to rerun the migration'],
  ['tell Claude to rerun the migration, send it please', 'tell Claude to rerun the migration'],
  ['tell Claude to rerun the migration and submit it', 'tell Claude to rerun the migration'],
  ['tell it to update the docs and send it now', 'tell it to update the docs'],
  ['tell it to update the docs, go ahead and send', 'tell it to update the docs'],
  ['tell it to fix the login’s redirect and just send it', 'tell it to fix the login\x27s redirect'],
  ['send Claude: add a README section about setup', 'add a README section about setup'],
  ['send this to Claude: run the tests', 'run the tests'],
  ['send Claude a message saying the deploy is done', 'the deploy is done'],
  ['okay send Claude: undo the last commit', 'undo the last commit'],
];
const no = [
  // Drafting is the default.
  'tell Claude to fix the tests',
  'fix the login',
  // Replies about a draft already made are consent, not a same-breath request.
  'send it',
  'yes send it',
  'okay, send it',
  'yeah go ahead and send it',
  // Not now, or not at all.
  "draft a prompt to fix the nav but don't send it yet",
  "tell it to fix the nav, but don't send it",
  "tell it to fix the nav and don't send it",
  'tell it to fix the nav and send it later',
  'tell it to fix the nav and send it tomorrow',
  'tell it to fix the nav and send it when I say so',
  'tell it to fix the nav and send it after lunch',
  'tell it to fix the nav, never send it',
  // Questions.
  'should I send it?',
  'tell it to fix the nav, should I send it?',
  'tell it to fix the nav, can you send it?',
  'do you want me to send it',
  // The words are the work.
  'tell Claude to write a function that says send it',
  'tell it to add a button that says send it now',
  'tell it to add a button labeled send',
  'tell it to print send it',
  "tell it to log 'send it' when the upload ends",
  'tell Claude to email the report and send it to Sam',
  'tell it to build the package and send it to the server',
  'tell Claude to send it',
  'have it send that',
  'tell it to rename the send it button',
  'tell Claude to deploy and ship it', // "ship it" may be the work (a deploy)
  // Not words at all.
  '',
  '   ',
];

test('a request that also says to send it, in so many words', () => {
  for (const [w, rest] of yes) {
    const r = sendInstruction(w);
    assert.equal(r.send, true, w);
    assert.equal(r.rest, rest, w);
  }
});

test('never a send: drafting by default, replies, "not yet", questions, and send words that are the work', () => {
  for (const w of no) assert.equal(sendInstruction(w).send, false, JSON.stringify(w));
});

test('what Orbit hears is never more than the words (no injection through odd input)', () => {
  for (const w of [null, undefined, 42, {}, [], 'send it‮', '\u0000 send it', 'send\nit', 'x '.repeat(5000) + 'and send it']) {
    const r = sendInstruction(w);
    assert.equal(typeof r.send, 'boolean');
    assert.equal(typeof r.rest, 'string');
  }
  assert.equal(sendInstruction('x '.repeat(5000) + 'and send it').send, true);
});

test('a draft keeps nothing of the send instruction', () => {
  assert.equal(withoutSendTail('Fix the failing tests and send it.'), 'Fix the failing tests.');
  assert.equal(withoutSendTail('Run the build. Just send it.'), 'Run the build.');
  assert.equal(withoutSendTail('Update the changelog, go ahead and send that'), 'Update the changelog.');
  assert.equal(withoutSendTail('Commit everything, don\x27t ask me, just send it.'), 'Commit everything.');
  assert.equal(withoutSendTail('Fix the failing tests.'), 'Fix the failing tests.');
  assert.equal(withoutSendTail('Commit everything. Don\x27t ask me.'), 'Commit everything.');
  assert.equal(withoutSendTail('Commit everything, no need to confirm'), 'Commit everything.');
  assert.equal(withoutSendTail('Write a function that says send it.'), 'Write a function that says send it.');
  assert.equal(withoutSendTail('Print send it'), 'Print send it');
  assert.equal(withoutSendTail('Send it.'), 'Send it.');
});
