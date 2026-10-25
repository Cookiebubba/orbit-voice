// "Wheee!" when Qubit is thrown: only for a real throw (not a put-down), once per throw (never on a
// bounce), never overlapping itself (a new throw restarts it), at the voice volume, and only with
// Settings -> Avatar -> Throw your avatar and Sound when thrown on (sanitised in src/config.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { THROW_SOUND, throwSoundFor } from '../ui/src/buddy/throw.js';
import { THROW_SOUND_URL, createThrowSound } from '../ui/src/throwSound.js';
import { volumeGain } from '../ui/src/playback.js';
import { DEFAULTS, getSettings, initConfig, updateSettings } from '../src/config.js';

const SIDE = 36;

test('the sound is for a real throw only: a put-down or a slow let-go makes none', () => {
  const fast = { x: -900, y: -500 };
  assert.equal(throwSoundFor(fast, SIDE, {}), true);
  assert.equal(throwSoundFor({ x: 0, y: 0 }, SIDE, {}), false, 'put down (let go still): no sound');
  assert.equal(throwSoundFor({ x: 120, y: 60 }, SIDE, {}), false, 'a gentle set-down: no sound');
  const edge = THROW_SOUND.minSpeedS * SIDE;
  assert.equal(throwSoundFor({ x: edge - 1, y: 0 }, SIDE, {}), false);
  assert.equal(throwSoundFor({ x: 0, y: edge }, SIDE, {}), true, 'at the threshold, any direction');
  assert.equal(throwSoundFor(fast, SIDE, { throwSound: false }), false, 'Sound when thrown off');
  assert.equal(throwSoundFor(fast, SIDE, { throw: false }), false, 'Throw your avatar off');
  assert.equal(throwSoundFor({ x: NaN, y: 'x' }, SIDE, {}), false);
  assert.equal(throwSoundFor(fast, 0, {}), false);
});

test('the player: once per call, restarted (never overlapping), at the voice volume', () => {
  const made = [];
  const fake = (src) => {
    const a = { src, currentTime: 0.9, volume: 1, playing: 0, pauses: 0, play() { this.playing++; return Promise.resolve(); }, pause() { this.pauses++; } };
    made.push(a);
    return a;
  };
  const s = createThrowSound({ makeAudio: fake, gain: volumeGain });
  const ms = s.play(0.75);
  assert.equal(made.length, 1);
  assert.equal(made[0].src, THROW_SOUND_URL);
  assert.equal(made[0].playing, 1);
  assert.ok(Math.abs(made[0].volume - volumeGain(0.75)) < 1e-9, 'the voice volume, as the voice plays it');
  assert.ok(ms >= 1360 && ms < 2000, 'about the clip (1.36 s)');
  made[0].currentTime = 0.6; // halfway through, a new throw
  s.play(0.3);
  assert.equal(made.length, 1, 'one player: it never overlaps itself');
  assert.equal(made[0].currentTime, 0, 'a new throw restarts it');
  assert.ok(made[0].pauses >= 2);
  assert.equal(made[0].playing, 2);
  assert.ok(Math.abs(made[0].volume - volumeGain(0.3)) < 1e-9);
  assert.equal(s.plays, 2);
  // No audio device: it never throws.
  const broken = createThrowSound({ makeAudio: () => { throw new Error('no device'); } });
  assert.doesNotThrow(() => broken.play(1));
});

test('the clip ships with the app', () => {
  const f = path.join(import.meta.dirname, '..', 'ui', 'public', 'sounds', 'wheee.mp3');
  const b = fs.readFileSync(f);
  assert.ok(b.length > 10_000 && b.length < 200_000, `${b.length} bytes`);
  assert.ok(b[0] === 0x49 || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0), 'an mp3 (ID3 tag or a frame header)');
});

test('settings: "Sound when thrown" is on by default and only takes a real yes or no', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-throw-sound-'));
  const store = { get: () => '', set() {}, kind: 'test' };
  try {
    assert.equal(DEFAULTS.avatarThrowSound, true);
    initConfig({ dir, secrets: store, brainSecrets: store });
    assert.equal(getSettings().avatarThrowSound, true);
    assert.deepEqual(updateSettings({ avatarThrowSound: false }), ['avatarThrowSound']);
    for (const junk of [{}, 'nope', 1, null]) assert.deepEqual(updateSettings({ avatarThrowSound: junk }), []);
    assert.equal(getSettings().avatarThrowSound, false);
    updateSettings({ avatarThrowSound: 'true' });
    assert.equal(getSettings().avatarThrowSound, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
