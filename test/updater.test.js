// The updater's plain-language errors, and that a copy run from source never checks.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpdater, describeUpdateError } from '../electron/updater.js';

test('update errors read as short plain reasons', () => {
  assert.equal(describeUpdateError('net::ERR_INTERNET_DISCONNECTED'), "Couldn't reach GitHub. Check your connection.");
  assert.equal(describeUpdateError('getaddrinfo ENOTFOUND github.com'), "Couldn't reach GitHub. Check your connection.");
  assert.equal(describeUpdateError('Cannot find latest.yml in the latest release artifacts'), 'The newest release has no update info yet.');
  assert.equal(describeUpdateError('sha512 checksum mismatch, expected abc'), 'The download was damaged, so it was thrown away. It will retry.');
  assert.equal(describeUpdateError('something else'), "Couldn't check for updates.");
});

test('running from source: status "dev", no checks, nothing to install', async () => {
  const seen = [];
  const u = createUpdater({ isPackaged: false, auto: true, onChange: (s) => seen.push(s) });
  assert.deepEqual(u.state(), { status: 'dev' });
  assert.deepEqual(await u.check(), { status: 'dev' });
  assert.equal(u.install(), false);
  u.stop();
  assert.deepEqual(seen, [], 'no state changes from source');
});
