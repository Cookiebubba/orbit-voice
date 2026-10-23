// What the user's own words decide about a prompt Claude is blocked on (the gate on
// answer_claude_prompt). Synthetic prompts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionFrom, describePrompt } from '../src/claude-prompt.js';

const PERM = { kind: 'permission', title: 'Allow Claude to run a command?', detail: 'npm install', options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'allow_always', label: 'Always allow' }, { id: 'deny', label: 'Deny' }], key: 'k' };
const Q = { kind: 'question', question: 'Which database?', choices: [{ n: 1, label: 'Redis', description: 'fast' }, { n: 2, label: 'Postgres', description: 'durable' }, { n: 3, label: 'SQLite file', description: '' }], key: 'q' };
const YN = { kind: 'question', question: 'Add tests?', choices: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], key: 'yn' };
const d = (t, p = PERM) => decisionFrom(t, p);

test('permission: allow once, deny, and always only in so many words', () => {
  for (const t of ['allow it', 'yes', 'Yeah, go ahead.', 'ok', 'approve it', 'sure, let it run', 'run it', 'allow']) assert.equal(d(t)?.choice, 'allow_once', t);
  for (const t of ['deny that', 'no', "don't allow it", 'nope', 'reject it', 'deny', 'no, block it']) assert.equal(d(t)?.choice, 'deny', t);
  for (const t of ['always allow', 'allow it always', "yes, and don't ask again", 'allow it from now on']) assert.equal(d(t)?.choice, 'allow_always', t);
  assert.equal(d('allow it for this session')?.choice, 'allow_session');
  for (const t of ['', 'what is it asking', 'hmm', 'yes no wait', 'go with the second option', 'should I allow it?', 'is it safe to allow']) assert.equal(d(t), null, t);
  assert.equal(d('can you allow it')?.choice, 'allow_once', 'a request, not a question');
});

test('a plain yes or no is marked generic (it must come after the latest notification)', () => {
  assert.equal(d('yes').generic, true);
  assert.equal(d('no').generic, true);
  assert.equal(d('allow it').generic, false);
  assert.equal(d('deny that').generic, false);
});

test('questions: by position, by the option\x27s own words, or skip', () => {
  for (const [t, n] of [['go with the second option', 2], ['the first one', 1], ['option two', 2], ['number 3', 3], ['two', 2], ['Postgres', 2], ['use Redis', 1], ['the SQLite file please', 3], ['the last one', 3], ['option b', 2]]) {
    assert.deepEqual(d(t, Q), { choice: 'option', option: n, generic: false }, t);
  }
  assert.equal(d('skip it', Q)?.choice, 'skip');
  for (const t of ['allow it', 'yes', 'the second one, Redis', 'option five', 'first or second', "what's it asking", 'use MongoDB']) assert.equal(d(t, Q), null, t);
  assert.equal(d('yes', YN)?.option, 1, 'an option named Yes');
  assert.equal(d('no', YN)?.option, 2);
});

test('the prompt as the voice model gets it: short, and its answers by name', () => {
  assert.deepEqual(describePrompt(PERM), { kind: 'permission', asks: 'Allow Claude to run a command?', command: 'npm install', answers: ['allow', 'always_allow', 'deny'], labels: ['Allow once', 'Always allow', 'Deny'] });
  const q = describePrompt(Q);
  assert.equal(q.question, 'Which database?');
  assert.deepEqual(q.options.map((o) => o.number), [1, 2, 3]);
  assert.equal(describePrompt(null), null);
});
