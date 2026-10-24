// What Orbit says when a send didn't go through: the window's real reason, never a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendFailureStep } from '../src/tools.js';

test('a failed send: the reason Claude\x27s window gave, the draft still there, no "bring the window up"', () => {
  const working = sendFailureStep({ error: 'send_button_not_found', why: 'claude_working', draftKept: true });
  assert.match(working, /still working/);
  assert.match(working, /still in Claude's box/);
  const greyed = sendFailureStep({ error: 'send_button_not_found', why: 'send_disabled', draftKept: true });
  assert.match(greyed, /greyed out/);
  const missing = sendFailureStep({ error: 'send_button_not_found', why: 'not_found', draftKept: true });
  assert.match(missing, /background/);
  for (const s of [working, greyed, missing]) assert.doesNotMatch(s, /bring (the|Claude's) window (up|forward)(?! forward)|window up and/i);
  assert.match(sendFailureStep({ error: 'prompt_box_changed' }), /type the draft in again/);
  assert.doesNotMatch(sendFailureStep({ error: 'send_button_not_found', draftKept: false }), /still in Claude's box/);
});
