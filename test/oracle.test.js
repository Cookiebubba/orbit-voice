// Orbit Native's Swift engine is held to the Node core by fixtures of the core's own answers
// (parity/oracle). If the JS changes, they must be made again (node parity/oracle/gen.mjs, on a Mac
// for the Mac-only ones), and the Swift engine then follows them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stale } from '../parity/oracle/gen.mjs';

test('the engine oracle fixtures match what the core answers now', async () => {
  assert.deepEqual(await stale(), [], 'stale fixtures: run node parity/oracle/gen.mjs (on a Mac) and update the Swift engine to match');
});
