// "Stop" for Claude: the fast path's strict match, and the looser gate on stop_claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asksToStop, isStopCommand } from '../src/stop-command.js';
import { isSleepCommand } from '../src/sleep-command.js';
import { matchAvatarCommand } from '../src/avatar-commands.js';

test('a bare stop is a stop command (the fast path)', () => {
  for (const t of ['stop', 'Stop.', 'stop it', 'Stop it!', 'stop Claude', 'no, stop', "that's wrong, stop", 'wait, stop it', 'um, stop', 'okay stop please', 'stop, stop', 'cancel that run', 'whoa whoa stop', 'stop now', 'stop it now', 'Claude, stop!', 'interrupt it']) {
    assert.equal(isStopCommand(t), true, t);
    assert.equal(asksToStop(t), true, t);
  }
});

test('anything more, or for Orbit, is not the fast path', () => {
  for (const t of ["stop it Claude's going the wrong way", 'stop listening', 'stop talking', "don't stop", 'hey Orbit stop', 'Qubit stop', 'stop dancing', 'tell Claude to add a stop button', 'go to sleep', 'did it stop', 'stop the server and restart it', '']) {
    assert.equal(isStopCommand(t), false, t);
  }
});

test('"stop listening" is sleep, not a stop; stop words never trigger the avatar', () => {
  assert.equal(isSleepCommand('stop listening'), true);
  assert.equal(asksToStop('stop listening'), false);
  assert.equal(isSleepCommand('stop'), false);
  for (const t of ['stop', 'stop it', 'stop Claude']) assert.equal(matchAvatarCommand(t, { avatar: 'qubit' })?.sure ?? false, false, t);
});

test('the gate: the user\x27s words must ask to stop Claude', () => {
  for (const t of ["stop it Claude's going the wrong way", 'can you stop Claude', 'tell it to stop', 'have it stop now', 'will you stop it', 'kill it', 'abort the run', 'cancel the task', 'stop the build', "that's wrong, stop"]) assert.equal(asksToStop(t), true, t);
  for (const t of ["don't stop", 'keep going', 'keep going, never stop', 'stop listening', 'stop talking', 'tell Claude to add a stop button', 'tell claude to stop using var', 'ask it to stop adding comments', 'did it stop?', 'why does it stop there', 'yes', 'send it', 'what is Claude doing', '']) assert.equal(asksToStop(t), false, t);
});

test('"cancel that" with a draft waiting is about the draft', () => {
  assert.equal(asksToStop('cancel that'), false, 'no run named');
  assert.equal(asksToStop('cancel that', { hasDraft: true }), false);
  assert.equal(asksToStop('cancel that run', { hasDraft: true }), false, 'a draft waiting: cancel means the draft');
  assert.equal(asksToStop('cancel what Claude is doing'), true);
  assert.equal(asksToStop('stop it', { hasDraft: true }), true, '"stop" is never the draft');
});
