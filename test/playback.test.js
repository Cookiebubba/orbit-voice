// ui/src/playback.js: how loud Orbit's voice plays (and the chimes with it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOLUME, chimeLevel, volumeGain } from '../ui/src/playback.js';

test('volume to gain: squared, 0 to 1, a sane default', () => {
  assert.equal(volumeGain(1), 1);
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(0.5), 0.25);
  assert.equal(volumeGain(2), 1);
  assert.equal(volumeGain(-1), 0);
  assert.equal(volumeGain(NaN), volumeGain(DEFAULT_VOLUME));
  assert.ok(DEFAULT_VOLUME >= 0.7 && DEFAULT_VOLUME <= 0.8);
  // The default is quieter than before (gain 1), by about 5 dB.
  assert.ok(Math.abs(20 * Math.log10(volumeGain(DEFAULT_VOLUME)) + 5) < 0.1);
});

test('the chimes stay as loud as before at the default, and follow the voice', () => {
  assert.equal(chimeLevel(DEFAULT_VOLUME), 0.12);
  assert.ok(chimeLevel(0.3) < 0.12);
  assert.equal(chimeLevel(0), 0);
  assert.ok(chimeLevel(1) <= 0.2);
});
