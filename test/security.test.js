// Regression tests for the 2026-10-19 security review (docs/security/2026-10-19-review.md) and
// for bugs the fuzzer found. Session data lives in a throwaway home folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sec-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');

const { listDesktopSessions, readTranscriptTail, resolveSession, findTranscript } = await import('../src/sessions.js');
const { scrub } = await import('../src/log.js');
const { brainArgs, isLocalAbsolute } = await import('../src/brain.js');

const metaDir = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions', 'a', 'o');
fs.mkdirSync(metaDir, { recursive: true });
const meta = (name, obj) => fs.writeFileSync(path.join(metaDir, `local_${name}.json`), typeof obj === 'string' ? obj : JSON.stringify(obj));

test('damaged session files are skipped, never crash the session list', () => {
  meta('good', { sessionId: 'local_good', cliSessionId: 'abc-123', title: 'Good one', cwd: 'C:\\proj', lastFocusedAt: 5 });
  meta('numcwd', { sessionId: 'local_numcwd', cliSessionId: 'def-456', title: 42, cwd: 42, originCwd: {}, lastFocusedAt: 'x' });
  meta('traversal', { sessionId: 'local_t', cliSessionId: '../../secrets/key', title: 'evil' });
  meta('noid', { cliSessionId: 'ghi-789', title: 'no session id' });
  meta('array', '[1,2,3]');
  meta('null', 'null');
  meta('broken', '{"cliSessionId": ');
  const all = listDesktopSessions();
  const ids = all.map((s) => s.cliSessionId).sort();
  assert.deepEqual(ids, ['abc-123', 'def-456', 'ghi-789'], 'only plain CLI ids are kept (no path pieces)');
  for (const s of all) for (const k of ['id', 'title', 'cwd', 'project']) assert.equal(typeof s[k], 'string', k);
  assert.ok(resolveSession('good'));
  assert.ok(resolveSession('42') !== undefined);
  assert.doesNotThrow(() => findTranscript('abc-123', 'C:\\proj'));
});

test('transcript parsing survives odd records and stays fast on unclosed tags (was quadratic)', () => {
  const dir = path.join(process.env.USERPROFILE, '.claude', 'projects', 'x');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'abc-123.jsonl');
  const bomb = '<pasted_content'.repeat(20000) + '<system-reminder>'.repeat(5000) + '<command-x>'.repeat(5000);
  const lines = [
    JSON.stringify({ type: 'user', message: { content: bomb } }),
    JSON.stringify({ type: 'user', message: { content: [null, 7, { type: 'text', text: { not: 'a string' } }, { type: 'text', text: 'hi <system-reminder>hidden</system-reminder>there' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: { x: 1 }, input: 'str' }, { type: 'text', text: 'done' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: { not: 'an array' } } }),
    'null',
    '7',
    JSON.stringify({ type: 'user', message: 'just a string' }),
  ];
  fs.writeFileSync(file, lines.join('\n'));
  const t0 = performance.now();
  const r = readTranscriptTail(file, { lastN: 10, includeTools: true, maxCharsPerMessage: 20000 });
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `took ${Math.round(ms)}ms`);
  assert.ok(r.turns.some((t) => t.text === 'hi there'), 'closed tags are still stripped');
  assert.ok(r.turns.every((t) => typeof t.text === 'string'));
});

test('the log hides Anthropic keys too', () => {
  const key = 'sk-ant-api03-' + 'x'.repeat(80);
  assert.ok(!scrub(`failed with ${key} in it`).includes(key));
  assert.ok(!scrub('xai-ABCDEFGHIJKLMNOP').includes('ABCDEFGHIJKLMNOP'));
});

test('the second brain is confined to the project folder and keeps secrets out', () => {
  for (const explore of [true, false]) {
    const args = brainArgs({ model: 'haiku', explore });
    assert.ok(args.includes('--restricted'), 'file tools stay inside the working folder');
    const deny = JSON.parse(args[args.indexOf('--settings') + 1]).permissions.deny;
    for (const p of ['Read(**/.env)', 'Read(**/.ENV)', 'Read(**/.git-credentials)', 'Read(**/.credentials*)', 'Read(**/.ssh/**)', 'Read(**/id_ecdsa*)', 'Read(**/.git/config)', 'Read(**/.dev.vars)']) {
      assert.ok(deny.includes(p), p);
    }
  }
  assert.equal(isLocalAbsolute('\\\\server\\share\\claude.exe'), false);
  assert.equal(isLocalAbsolute('//server/share/claude.exe'), false);
  assert.equal(isLocalAbsolute('C:\\tools\\claude.exe'), true);
});
