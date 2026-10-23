// The watcher notices Claude blocked on the user: its log ends in a tool call that hasn't run.
// A question (AskUserQuestion) is reported once; any other tool (it may just be running) is
// offered for a check in the Claude window, twice at most; a session in bypass mode never asks
// permission, so its stalled tools are not. Synthetic sessions in a temp profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-watcher-'));
process.env.USERPROFILE = process.env.HOME = path.join(root, 'home');
process.env.APPDATA = path.join(root, 'appdata');
process.env.LOCALAPPDATA = path.join(root, 'local');
const meta = path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions', 'acct', 'org');
fs.mkdirSync(meta, { recursive: true });
const now = Date.now();
function session(id, title, tool, permissionMode = 'default') {
  const cwd = path.join(root, 'proj', id);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(meta, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, title, cwd, permissionMode, createdAt: now - 60_000, lastFocusedAt: now, lastActivityAt: now }));
  const dir = path.join(process.env.USERPROFILE, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', timestamp: t, message: { role: 'user', content: 'go' } })}\n${JSON.stringify({ type: 'assistant', timestamp: t, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: tool, input: {} }] } })}\n`);
}
session('q1', 'Question session', 'AskUserQuestion');
session('b1', 'Bash session', 'Bash');
session('x1', 'Bypass session', 'Bash', 'bypassPermissions');
session('y1', 'Bypass question', 'AskUserQuestion', 'bypassPermissions');

const { createSessionWatcher } = await import('../src/watcher.js');

test('a stalled tool call is reported as Claude maybe waiting on the user', { timeout: 30_000 }, async () => {
  const w = createSessionWatcher();
  const got = [];
  w.on((e) => e.type === 'claude.waiting' && got.push(e));
  w.start();
  try {
    for (let i = 0; i < 70 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    const by = (title) => got.filter((e) => e.title === title);
    assert.equal(by('Question session').length, 1);
    assert.equal(by('Question session')[0].kind, 'question');
    assert.equal(by('Bash session')[0]?.kind, 'tool', 'a stalled Bash call: maybe a permission prompt');
    assert.equal(by('Bash session')[0].toolId, 'toolu_b1');
    assert.equal(by('Bypass session').length, 0, 'bypass mode never asks permission');
    assert.equal(by('Bypass question').length, 1, 'but questions still wait in bypass mode');
  } finally {
    w.stop();
  }
});
