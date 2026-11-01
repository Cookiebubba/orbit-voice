// Run only through test/fuzz/register.mjs: the transport must be an in-memory fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeClipboard, setClipboardWriter, MAX_CLIPBOARD_CHARS } from '../../src/clipboard.js';
import { writeClipboard as fakeWriteClipboard } from '../fuzz/fake-clipboard.mjs';

test('sandbox clipboard uses only its in-memory transport and keeps production bounds', async () => {
  assert.equal(writeClipboard, fakeWriteClipboard, 'sandbox loader must never select the OS clipboard transport');
  const copied = [];
  setClipboardWriter((text) => copied.push(text));
  try {
    assert.equal((await writeClipboard('fixture clipboard text')).ok, true);
    assert.deepEqual(copied, ['fixture clipboard text']);
    assert.equal((await writeClipboard('')).ok, false);
    assert.equal((await writeClipboard('x'.repeat(MAX_CLIPBOARD_CHARS + 1))).ok, false);
    assert.equal(copied.length, 1);
  } finally { setClipboardWriter(null); }
});
