import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEncryptedKeyStore } from '../electron/encrypted-key-store.js';

const fixtureKey = 'sk-fixture-not-a-real-provider-key-12345';
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-key-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`fixture-sealed:${Buffer.from(s).toString('base64')}`),
    decryptString: (b) => {
      const text = b.toString();
      if (!text.startsWith('fixture-sealed:')) throw new Error('private decrypt detail');
      return Buffer.from(text.slice('fixture-sealed:'.length), 'base64').toString();
    },
    ...overrides,
  };
  return { dir, file: path.join(dir, 'openai-key.bin'), safeStorage, store: createEncryptedKeyStore({ dir, name: 'openai-key.bin', safeStorage }) };
}

test('native key store distinguishes absent, encrypted present and cleared states', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.readState(), { state: 'absent' });
  assert.equal(f.store.get(), '');
  f.store.set(fixtureKey);
  assert.deepEqual(f.store.readState(), { state: 'present', key: fixtureKey });
  assert.equal(f.store.get(), fixtureKey);
  assert.equal(fs.readFileSync(f.file).includes(Buffer.from(fixtureKey)), false);
  assert.deepEqual(fs.readdirSync(f.dir), ['openai-key.bin'], 'no plaintext or temporary file is retained');
  f.store.set('');
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.store.readState(), { state: 'absent' });
  f.store.set(''); // Removing an already absent store is harmless.
});

test('an unreadable or undecryptable saved store is not an absent key', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'malformed encrypted fixture');
  assert.deepEqual(f.store.readState(), { state: 'error', present: true });
  assert.equal(f.store.get(), '', 'legacy get callers retain their old interface');
  fs.unlinkSync(f.file);
  fs.mkdirSync(f.file);
  assert.deepEqual(f.store.readState(), { state: 'error', present: true });
});

test('encryption unavailability fails closed but allows removal of this store only', (t) => {
  const f = fixture(t);
  f.store.set(fixtureKey);
  const sibling = path.join(f.dir, 'anthropic-key.bin');
  fs.writeFileSync(sibling, 'unrelated encrypted fixture');
  f.safeStorage.isEncryptionAvailable = () => false;
  assert.deepEqual(f.store.readState(), { state: 'error', present: true });
  assert.throws(() => f.store.set('sk-replacement-fixture'), /Windows encryption is not available/);
  f.store.set('');
  assert.deepEqual(f.store.readState(), { state: 'absent' });
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'unrelated encrypted fixture');
});

test('failed encryption preserves the old key and never includes key/error details', (t) => {
  const f = fixture(t);
  f.store.set(fixtureKey);
  f.safeStorage.encryptString = () => { throw new Error(`${fixtureKey} private encryption detail`); };
  assert.throws(() => f.store.set('sk-replacement-fixture'), (error) => error.message === 'Windows encryption failed, so the key was not saved.');
  assert.equal(f.store.get(), fixtureKey);
  assert.deepEqual(fs.readdirSync(f.dir), ['openai-key.bin']);
});

test('legacy successfully decrypted empty store is absent rather than corrupt', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, f.safeStorage.encryptString(''));
  assert.deepEqual(f.store.readState(), { state: 'absent' });
});
