// Orbit Native's Swift engine is held to the Node core by fixtures of the core's own answers
// (parity/oracle). If the JS changes, they must be made again (node parity/oracle/gen.mjs, on a Mac
// for the Mac-only ones), and the Swift engine then follows them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, stale } from '../parity/oracle/gen.mjs';

test('the engine oracle fixtures match what the core answers now', async () => {
  assert.deepEqual(await stale(), [], 'stale fixtures: run node parity/oracle/gen.mjs (on a Mac) and update the Swift engine to match');
});

// The Mac-only fixtures can't be checked off a Mac, but policy's window texts are the intent corpus
// itself (and voice samples the same corpus): when intent changes and only intent is made again
// (on Windows), they go stale unseen. Caught here, on any OS.
test('the Mac-only fixtures were made from the same corpus as intent', () => {
  const read = (n) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${n}.json`), 'utf8'));
  const intent = read('intent').cases.map((c) => c.input);
  const policy = read('policy').windowTexts.map((c) => c.input);
  assert.deepEqual(policy, intent, 'policy (and voice) are stale: run node parity/oracle/gen.mjs on a Mac');
});
