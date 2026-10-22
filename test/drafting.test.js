// Dictated prompts stay the user's own words: Orbit removes filler sounds itself (never when asked
// for it verbatim) and refuses a draft with words the user didn't say.

import test from 'node:test';
import assert from 'node:assert/strict';
import { asksVerbatim, removeFillers, wordsNotSaid } from '../src/tools.js';

test('filler sounds go, and nothing else changes', () => {
  assert.equal(removeFillers('Um, fix the failing test.'), 'Fix the failing test.');
  assert.equal(removeFillers('fix the, uh, failing test'), 'fix the, failing test');
  assert.equal(removeFillers('run the tests um.'), 'run the tests.');
  assert.equal(removeFillers('uhh so ermm add a cache hmm'), 'So add a cache');
  assert.equal(removeFillers('Add a retry.\nUm, then log it.'), 'Add a retry.\nThen log it.');
  // Not fillers: capitals that are likely meant, and words that only look close.
  assert.equal(removeFillers('send it to the ER team'), 'send it to the ER team');
  assert.equal(removeFillers('the umbrella and the human error'), 'the umbrella and the human error');
  // Stutters and odd wording stay: they're the user's words.
  assert.equal(removeFillers('I I think it should, like, retry twice'), 'I I think it should, like, retry twice');
});

test('a draft may only use words the user said', () => {
  const said = 'tell claude to um fix the failing login test and dont touch the API';
  assert.deepEqual(wordsNotSaid('Fix the failing login test, and don\x27t touch the API.', said), []);
  assert.deepEqual(wordsNotSaid('Please fix the broken login test', said), ['please', 'broken']);
  assert.deepEqual(wordsNotSaid('rm -rf /', said), ['rm', 'rf']);
});

test('"verbatim" and "word for word" ask for the exact words', () => {
  assert.equal(asksVerbatim('send this verbatim: um, ship it'), true);
  assert.equal(asksVerbatim('tell it word for word'), true);
  assert.equal(asksVerbatim('tell Claude to ship it'), false);
});
