// "Go to sleep" hangs up at once, with no model turn, only when that's all the user said.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSleepCommand } from '../src/sleep-command.js';

test('a sleep command on its own hangs up straight away', () => {
  for (const s of [
    'go to sleep', 'Go to sleep.', 'um, go to sleep', 'Hey Orbit, go to sleep', 'okay, go to sleep, thanks',
    'Goodnight!', 'good night Orbit', 'stop listening', 'hang up', 'sleep', 'go back to sleep', 'you can go to sleep now',
    'alright thank you, bye', 'Qubit, take a nap', 'bye bye', 'Okay. Bye.',
  ]) assert.equal(isSleepCommand(s), true, s);
});

test('anything more goes to the model', () => {
  for (const s of [
    'tell Claude to go to sleep', 'go to sleep after you send it', 'send it and go to sleep', 'add a sleep call to the retry loop',
    "don't go to sleep", 'why did you go to sleep', 'sleep mode is broken', "that's it", "that's all", 'yes', 'thanks', '', 'okay',
    'go to sleep go to sleep go to sleep go to sleep',
  ]) assert.equal(isSleepCommand(s), false, s);
});

test('the name as speech to text often hears it, and "for a bit", still just mean sleep', () => {
  for (const s of ['Go to sleep or bit.', 'go to sleep, orb it', 'Go to sleep for a bit.', 'go to sleep a little bit', 'Qubit, go to sleep for a while', 'go to sleep for now']) assert.equal(isSleepCommand(s), true, s);
  for (const s of ['go to sleep or bit and send it', 'a bit more sleep in the retry loop']) assert.equal(isSleepCommand(s), false, s);
});
