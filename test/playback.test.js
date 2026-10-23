// ui/src/playback.js: how loud Orbit's voice plays (and the chimes with it), and how a reply ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOLUME, FINISH_WITHIN_S, RELEASE_MS, chimeLevel, letItFinish, releaseTail, volumeGain } from '../ui/src/playback.js';

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

test('a release follows audio that stops abruptly: from its last sample, falling away, ~120 ms', () => {
  const pcm = new Int16Array(2400).map((_, i) => Math.round(Math.sin((2 * Math.PI * 880 * i) / 24000) * 16000));
  const tail = releaseTail(pcm);
  assert.equal(tail.length, Math.round((24000 * RELEASE_MS) / 1000));
  assert.ok(RELEASE_MS >= 80 && RELEASE_MS <= 150);
  const last = pcm.at(-1) / 0x8000;
  assert.ok(Math.abs(tail[0] - last) < 0.01, 'it carries on from the very last sample (no jump)');
  const rms = (a, b) => Math.sqrt(tail.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
  assert.ok(rms(0, 240) > rms(1200, 1440) && rms(1200, 1440) > rms(2400, 2640), 'it falls away');
  assert.ok(Math.abs(tail.at(-1)) < 0.5 / 200, 'to about -48 dB');
});

test('no release for audio that already ends in quiet, or no audio', () => {
  const pcm = new Int16Array(2400).map((_, i) => (i < 1800 ? Math.round(Math.sin(i / 3) * 16000) : 0));
  assert.equal(releaseTail(pcm), null);
  assert.equal(releaseTail(new Int16Array(0)), null);
  assert.equal(releaseTail(null), null);
  // A very short chunk still makes a full-length release.
  assert.equal(releaseTail(new Int16Array(50).fill(12000)).length, 2880);
});

test('talking over only the last moments of a finished reply lets it finish; anything earlier stops it', () => {
  assert.equal(letItFinish({ remainingS: 0.25, replyDone: true }), true);
  assert.equal(letItFinish({ remainingS: FINISH_WITHIN_S, replyDone: true }), true);
  assert.equal(letItFinish({ remainingS: 1.5, replyDone: true }), false, 'a real interruption');
  assert.equal(letItFinish({ remainingS: 0.25, replyDone: false }), false, 'more of the reply is still coming');
  assert.equal(letItFinish({ remainingS: 0, replyDone: true }), false, 'nothing playing');
});
