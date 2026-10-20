// Claude Code sign-in for the second brain: the status check, opening the sign-in, and spotting a
// run that failed because Claude Code is signed out. Fake processes only; nothing opens.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { askBrain, claudeAuthStatus, isSignInProblem, openClaudeSignIn } from '../src/brain.js';

/** A fake process that prints `stdout`, then exits (no stdin needed). */
function fakeProc(stdout, { calls = [], hang = false } = {}) {
  const impl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.kill = () => setImmediate(() => child.emit('close', null));
    child.unref = () => { calls.at(-1).unref = true; };
    calls.push({ exe, args, opts });
    setImmediate(() => child.emit('spawn'));
    if (!hang) {
      setTimeout(() => {
        child.stdout.end(stdout);
        child.emit('close', 0);
      }, 5);
    }
    return child;
  };
  return { impl, calls };
}

test('the status check reads `claude auth status --json`, spends nothing, and never trusts garbage', async () => {
  const yes = fakeProc(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  assert.deepEqual(await claudeAuthStatus({ claudePath: 'C:/x/claude.exe', spawnImpl: yes.impl }), { ok: true, signedIn: true, method: 'claude.ai' });
  assert.deepEqual(yes.calls[0].args, ['auth', 'status', '--json']);
  assert.equal(yes.calls[0].opts.env.ANTHROPIC_API_KEY, undefined, 'checks the Claude login, not an API key');

  const no = fakeProc(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
  assert.deepEqual(await claudeAuthStatus({ claudePath: 'C:/x/claude.exe', spawnImpl: no.impl }), { ok: true, signedIn: false, method: 'none' });

  for (const out of ['not json', JSON.stringify({ loggedIn: 'yes' }), '']) {
    const r = await claudeAuthStatus({ claudePath: 'C:/x/claude.exe', spawnImpl: fakeProc(out).impl });
    assert.ok(r.ok === false || r.signedIn === false, `never "signed in" from ${JSON.stringify(out)}`);
  }
  const slow = await claudeAuthStatus({ claudePath: 'C:/x/claude.exe', spawnImpl: fakeProc('', { hang: true }).impl, timeoutMs: 30 });
  assert.equal(slow.ok, false);
  assert.equal((await claudeAuthStatus({ claudePath: '' })).ok, false);
});

test('opening the sign-in runs `claude auth login` in its own window, with no shell', async () => {
  const calls = [];
  const r = await openClaudeSignIn({ claudePath: 'C:/x/claude.exe', spawnImpl: fakeProc('', { calls, hang: true }).impl });
  assert.equal(r.ok, true);
  assert.equal(calls[0].exe, 'C:/x/claude.exe');
  assert.deepEqual(calls[0].args, ['auth', 'login']);
  assert.equal(calls[0].opts.detached, true, 'its own console window on Windows');
  assert.equal(calls[0].opts.windowsHide, false);
  assert.equal(calls[0].opts.shell, undefined);
  assert.equal(calls[0].unref, true, 'Orbit doesn\x27t wait for it');
  assert.equal((await openClaudeSignIn({ claudePath: '' })).ok, false);
});

test('a run that fails for sign-in is flagged; other failures are not', async () => {
  const run = (result) =>
    askBrain({
      question: 'q?',
      model: 'haiku',
      claudePath: 'claude',
      spawnImpl: (exe, args, opts) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        child.stdin.on('finish', () => setTimeout(() => { child.stdout.end(JSON.stringify({ subtype: 'success', is_error: true, result })); child.emit('close', 1); }, 5));
        return child;
      },
    });
  // The exact text Claude Code 2.1.303 prints.
  const expired = await run('Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.equal(expired.needsSignIn, true);
  assert.match(expired.error, /sign-in has expired/);
  assert.equal((await run('Rate limit reached')).needsSignIn, false);
  assert.equal(isSignInProblem('Not logged in · Please run /login'), true);
  assert.equal(isSignInProblem('Overloaded'), false);
  // Found by the end-to-end fuzzer: told "sign-in has expired" but never offered the sign-in.
  assert.equal(isSignInProblem('OAuth token has expired. Please obtain a new token or refresh your existing token.'), true);
});
