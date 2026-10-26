// The parity suite's probes (parity/probes/*.js): the expressions Orbit Native's test builds evaluate
// in an avatar's page (mac-swift/scripts/build-app.sh ships them). Each must be one expression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the probes are single expressions that parse', () => {
  for (const f of ['qubit-art.js', 'figure.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'parity', 'probes', f), 'utf8');
    assert.doesNotThrow(() => new Function(`return ${src.replace(/^\s*\/\/.*$/gm, '').trim()}`), f);
  }
});
