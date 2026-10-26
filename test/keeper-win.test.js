// Apps under Orbit, for real (Windows): our own Discord-like test app (test/e2e/slate-input, a Slate
// message box like Discord's) started under Orbit's pipe keeper, then typed into, sent, clicked and
// pictured through the pipe, the way Orbit does it. Never another app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initConfig } from '../src/config.js';
import { connectKeeper, keeperForWindow, keepers, pageSession, setKeeperLauncher, startUnderKeeper } from '../src/anywhere/keeper.js';
import { cdpClick, cdpElementRect, cdpEnter, cdpScreenshot, cdpType } from '../src/anywhere/cdp.js';
import { SLATE_MAIN, electronPath } from './e2e/slate-input.mjs';
import { realDesktopSkip } from './e2e/real-desktop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = realDesktopSkip || (process.platform !== 'win32' && 'Windows only');

/** Query the page through the pipe (DOM only, never running code in it). */
async function count(win, selector) {
  const s = await pageSession(win);
  try {
    const doc = await s.call('DOM.getDocument', { depth: -1 });
    const r = await s.call('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector });
    const html = r.nodeIds?.length ? (await s.call('DOM.getOuterHTML', { nodeId: r.nodeIds[0] })).outerHTML : '';
    return { n: r.nodeIds?.length || 0, html };
  } finally {
    s.close();
  }
}

test('an app under Orbit: typed into, sent, clicked and pictured through the private pipe', { skip, timeout: 90_000 }, async () => {
  initConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-keeper-win-')) });
  setKeeperLauncher({ execPath: process.execPath, preArgs: [path.join(ROOT, 'src/anywhere/keeper-node.mjs')] });
  const title = `ORBIT-KEEPER-E2E-${process.pid}`;
  process.env.SLATE_X = '90';
  process.env.SLATE_Y = '90';
  const state = await startUnderKeeper({ exe: electronPath(), args: [SLATE_MAIN, title, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-slate-profile-'))}`], app: 'slate' });
  // As Orbit knows the window (its rect from the window watcher): the test app is 760x420 at 90,90.
  const win = { pid: state.appPid, title, rect: { x: 90, y: 90, w: 760, h: 420 } };
  try {
    assert.ok(keeperForWindow(win), 'Orbit sees the app is under it');
    await sleep(2500); // the page loads
    // Typing into the Slate box: real input events, so the app takes it.
    const typed = await cdpType(win, { name: 'Message #general', text: 'hello through the pipe' });
    assert.equal(typed.ok, true, typed.message);
    assert.equal(typed.via, 'pipe');
    // Enter sends (the caller gates it): the message appears in the list.
    const sent = await cdpEnter(win, { name: 'Message #general' });
    assert.equal(sent.ok, true, sent.message);
    await sleep(400);
    const msgs = await count(win, '#messages li.sent');
    assert.equal(msgs.n, 1, 'one message sent');
    assert.match(msgs.html, /hello through the pipe/);
    // A click on a channel, by its name, without the user's cursor.
    const click = await cdpClick(win, { name: 'random (text channel)', role: 'link' });
    assert.equal(click.ok, true, click.message);
    await sleep(300);
    assert.equal((await count(win, '[aria-label="Messages in random"]')).n, 1, 'the channel changed');
    // A picture of the page.
    const shot = await cdpScreenshot(win);
    assert.equal(shot.ok, true, shot.message);
    assert.ok(Buffer.from(shot.png, 'base64').length > 2000);
    // Where the box is on screen (for the Orbit mouse).
    const where = await cdpElementRect(win, { name: 'Message #random' });
    assert.equal(where.ok, true, JSON.stringify(where));
    assert.ok(where.rect.w > 50 && where.rect.h > 5 && where.rect.x >= 80 && where.rect.y >= 80, JSON.stringify(where.rect));
    // Orbit restarting: a fresh connection to the same keeper works.
    const again = await connectKeeper(state);
    const t = await again.call('Target.getTargets');
    assert.ok(t.targetInfos.some((x) => x.type === 'page'));
    again.close();
  } finally {
    try {
      process.kill(state.appPid);
    } catch {}
  }
  for (let i = 0; i < 50 && keepers().length; i++) await sleep(100);
  assert.equal(keepers().length, 0, 'the keeper ended with its app');
});
