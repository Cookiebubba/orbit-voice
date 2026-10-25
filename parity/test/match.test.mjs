// The Node matchers against the shared cases (the Swift runner checks the same file).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { at, interpolate, match } from '../lib/match.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, 'match-cases.json'), 'utf8'));

for (const c of cases) {
  test(`match: ${c.name}`, () => {
    const r = match(c.actual, c.expect, c.vars || {});
    assert.equal(r === null, c.pass, r || 'matched but should not have');
    if (!c.pass) assert.equal(typeof r, 'string');
  });
}

test('at walks objects and arrays, missing is undefined', () => {
  assert.equal(at({ a: [{ b: 2 }] }, 'a.0.b'), 2);
  assert.equal(at({ a: 1 }, 'a.b.c'), undefined);
  assert.deepEqual(at({ a: 1 }, ''), { a: 1 });
});

test('interpolate replaces whole values and inside strings', () => {
  assert.deepEqual(interpolate({ x: '${a}', y: 'n=${a.b}' }, { a: { b: 3 } }), { x: { b: 3 }, y: 'n=3' });
});
