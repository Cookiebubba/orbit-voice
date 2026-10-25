// Orbit on macOS, end to end, against windows this test opens itself (never the real Claude app or
// any other app of yours):
//   electron scripts/mac-e2e.mjs [--shots <folder>]
//
// A stand-in Claude window (test/e2e/mac-fake-claude.html: Claude's page structure, with an editor
// that keeps its own model like ProseMirror) and the real Orbit macOS helper (resources/mac/
// orbit-helper, npm run mac:helper):
//   - the Claude desktop driver (src/platform/mac/desktop.js): info, list, switch, fill / send, stop,
//     permission and question cards, new session (in a folder), the model picker;
//   - the Claude window watcher (claude-window mode): the window, its moves, the prompt box;
//   - the focus watcher (focus mode): the window in front, its title, a watched window's moves;
//   - reading (read, selection) and looking (capture + OCR).
// Needs Accessibility for the app running it (and Screen Recording for the capture step, else that
// step is skipped). Prints PASS / FAIL per step; exits 1 if any failed.

import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : '';
const { createMacDesktop } = await import('../src/platform/mac/desktop.js');
const { helperPath, macAxHost, runHelperOnce, spawnHelper } = await import('../src/platform/mac/helper.js');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push(`PASS ${name} (${Date.now() - t0} ms)${note ? `: ${note}` : ''}`);
  } catch (e) {
    failed++;
    results.push(`FAIL ${name}: ${String(e?.message || e).slice(0, 400)}`);
  }
  console.log(results.at(-1));
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};

/** A long-lived helper mode, its JSON lines collected. */
function helperStream(mode, extra = []) {
  const child = spawnHelper(mode, extra);
  const lines = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      return;
    }
    lines.push(j);
    for (const w of [...waiters]) if (w.test(j)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(j);
    }
  });
  return {
    child,
    lines,
    send: (s) => child.stdin.write(`${s}\n`),
    /** The next line (or one already seen since `from`) that passes `test`. */
    wait(test, ms = 5000, from = 0) {
      const seen = lines.slice(from).find(test);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`no matching ${mode} report within ${ms} ms`));
        }, ms);
      });
    },
    stop: () => child.kill(),
  };
}

app.whenReady().then(async () => {
  if (!helperPath()) {
    console.log('FAIL the helper is missing: npm run mac:helper');
    return app.exit(1);
  }
  const perms = await runHelperOnce(['perms']);
  console.log(`helper ${helperPath()}; Accessibility ${perms.ax ? 'on' : 'OFF'}, Screen Recording ${perms.screen ? 'on' : 'off'}`);
  if (!perms.ax) {
    console.log('FAIL Accessibility is off for the app running this test.');
    return app.exit(1);
  }
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x: area.x + 120, y: area.y + 60, width: 980, height: 700, title: 'Claude', show: true, webPreferences: { contextIsolation: true } });
  win.on('page-title-updated', (e) => e.preventDefault()); // Claude's window title stays "Claude"
  await win.loadFile(path.join(ROOT, 'test', 'e2e', 'mac-fake-claude.html'));
  const page = (js) => win.webContents.executeJavaScript(js);
  const state = () => page('window.fake.state()');
  await sleep(500);

  const host = macAxHost();
  const d = createMacDesktop({ request: (op, a) => host.request(op, a), onlyPid: process.pid });

  await step('desktop info: the session, the prompt box, the window', async () => {
    const r = await d.run('info', ['-Rects']);
    expect(r.ok, JSON.stringify(r));
    expect(r.sessionTitle === 'Fix the login bug', `title ${r.sessionTitle}`);
    expect(r.promptBoxFound && r.promptText === '', 'empty prompt box');
    expect(r.promptBoxRect && r.windowRect, 'rects');
    expect(r.sendButtonRect, 'Send found');
    return `box at ${JSON.stringify(r.promptBoxRect)}`;
  });

  await step('desktop list: the sidebar sessions', async () => {
    const r = await d.run('list', []);
    expect(r.ok, JSON.stringify(r));
    const titles = r.sessions.map((x) => x.title);
    expect(JSON.stringify(titles) === JSON.stringify(['Fix the login bug', 'Write the release notes', 'Plan viewer alpha']), titles.join(' | '));
  });

  await step('desktop switch: presses the session in the sidebar', async () => {
    const r = await d.run('switch', ['-TitleB64', b64('release notes')]);
    expect(r.ok && r.switched, JSON.stringify(r));
    expect((await state()).open === 'Write the release notes', 'the page switched');
  });

  await step('desktop fill: the draft reaches the editor’s own model', async () => {
    const r = await d.run('send', ['-TextB64', b64('Please run the tests'), '-Fill']);
    expect(r.ok && r.filled, JSON.stringify(r));
    const s = await state();
    expect(s.model === 'Please run the tests', `the editor's model has "${s.model}"`);
  });

  await step('desktop send the filled draft: Send pressed, box empty', async () => {
    const r = await d.run('send', ['-TextB64', b64('Please run the tests'), '-Filled']);
    expect(r.ok && r.sent && r.confirmed, JSON.stringify(r));
    const s = await state();
    expect(s.sent.at(-1) === 'Please run the tests', `sent ${JSON.stringify(s.sent)}`);
    expect(s.working, 'Claude works');
  });

  await step('desktop send while working: refused, box emptied again', async () => {
    const r = await d.run('send', ['-TextB64', b64('next')]);
    expect(r.error === 'send_button_not_found' && r.why === 'claude_working', JSON.stringify(r));
    expect((await state()).model === '', 'the box is empty again');
  });

  await step('desktop stop: Claude’s Stop pressed, Send back', async () => {
    const r = await d.run('stop', []);
    expect(r.ok && r.stopped && r.confirmed, JSON.stringify(r));
    expect(!(await state()).working, 'stopped');
  });

  await step('desktop never types over the user’s own text', async () => {
    await page("window.fake.typeAsUser('my own words')");
    const r = await d.run('send', ['-TextB64', b64('hello')]);
    expect(r.error === 'prompt_box_not_empty', JSON.stringify(r));
    expect((await state()).model === 'my own words', 'kept');
    await page("document.getElementById('prompt').innerHTML = '<p><br></p>'");
    await sleep(100);
  });

  await step('desktop send in one go (one long multi-line prompt)', async () => {
    const text = 'Line one of the prompt.\nLine two, with “quotes” and an apostrophe’s turn.';
    const r = await d.run('send', ['-TextB64', b64(text), '-ExpectTitleB64', b64('Write the release notes')]);
    expect(r.ok && r.sent, JSON.stringify(r));
    const s = await state();
    expect(s.sent.at(-1).includes('Line two'), `sent ${JSON.stringify(s.sent.at(-1))}`);
    await page("window.fake.set({ working: false })");
  });

  await step('desktop pending + answer: a permission card', async () => {
    await page("window.fake.set({ card: { kind: 'permission', title: 'Allow Claude to run a command?', command: 'npm test' } })");
    await sleep(150);
    const p = await d.run('pending', []);
    expect(p.ok && p.pending?.kind === 'permission', JSON.stringify(p));
    expect(p.pending.detail === 'npm test', `detail ${p.pending.detail}`);
    const a = await d.run('answer', ['-KeyB64', b64(p.pending.key), '-Choice', 'allow_once']);
    expect(a.ok && a.confirmed, JSON.stringify(a));
    expect((await state()).answer === 'Allow once', 'answered');
  });

  await step('desktop pending + answer: a question card', async () => {
    await page("window.fake.set({ card: { kind: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] } })");
    await sleep(150);
    const p = await d.run('pending', []);
    expect(p.ok && p.pending?.kind === 'question', JSON.stringify(p));
    expect(p.pending.choices.map((c) => c.label).join(',') === 'Postgres,SQLite', JSON.stringify(p.pending.choices));
    const a = await d.run('answer', ['-KeyB64', b64(p.pending.key), '-Choice', 'option', '-Option', '2']);
    expect(a.ok, JSON.stringify(a));
    expect((await state()).answer === 'SQLite', `answered ${(await state()).answer}`);
  });

  await step('desktop app: the model picker’s menu', async () => {
    const r = await d.run('app', ['-Action', 'model', '-ValueB64', b64('sonnet')]);
    expect(r.ok && r.now === 'Sonnet 5.5', JSON.stringify(r));
    expect((await state()).llm === 'Sonnet 5.5', 'picked');
  });

  await step('desktop new session in a folder, then the first prompt names it', async () => {
    const r = await d.run('new', ['-ProjectB64', b64('ladder 6')]);
    expect(r.ok && r.newSession && r.folder === 'Fire', JSON.stringify(r));
    const sr = await d.run('send', ['-TextB64', b64('Start the new feature'), '-ExpectNew', '-ExpectFolderB64', b64('Fire')]);
    expect(sr.ok && sr.sent && sr.sessionTitle === 'Start the new feature', JSON.stringify(sr));
    await page("window.fake.set({ working: false })");
  });

  // ---- the Claude window watcher ----
  const ourId = (await host.request('windows', { pid: process.pid })).windows?.find((w) => w.title === 'Claude')?.hwnd || 0;
  await step('claude-window: reports the window, follows a move, finds the prompt box', async () => {
    expect(ourId > 0, 'our window has an id');
    const cw = helperStream('claude-window', ['--pid', String(process.pid)]);
    try {
      const first = await cw.wait((j) => Array.isArray(j.wins) && j.wins.some((w) => w.hwnd === ourId));
      const w0 = first.wins.find((w) => w.hwnd === ourId);
      const b = win.getBounds();
      expect(Math.abs(w0.x - b.x) <= 2 && Math.abs(w0.w - b.width) <= 2, `rect ${JSON.stringify(w0)} vs ${JSON.stringify(b)}`);
      const from = cw.lines.length;
      win.setBounds({ ...b, x: b.x + 60, y: b.y + 30 });
      const moved = await cw.wait((j) => Array.isArray(j.wins) && j.wins.some((w) => w.hwnd === ourId && Math.abs(w.x - (b.x + 60)) <= 2), 4000, from);
      cw.send(`box ${ourId}`);
      const box = await cw.wait((j) => j.box && j.box.hwnd === ourId && j.box.rect, 5000);
      expect(box.box.rect.w > 100 && box.box.win.w > 500, JSON.stringify(box.box));
      win.setBounds(b);
      return `moved to x=${moved.wins.find((w) => w.hwnd === ourId).x}; box ${JSON.stringify(box.box.rect)}`;
    } finally {
      cw.stop();
    }
  });

  // ---- the focus watcher ----
  await step('focus: the window in front, and a watched window’s moves', async () => {
    const f = helperStream('focus');
    try {
      win.show();
      win.focus();
      app.focus({ steal: true });
      const fg = await f.wait((j) => j.fg && j.fg.hwnd === ourId, 6000);
      expect(fg.fg.kind === 'orbit' || fg.fg.kind === 'app', `kind ${fg.fg.kind}`);
      f.send(`watch 7 ${ourId}`);
      await f.wait((j) => j.id === 7 && j.watching === 1);
      const b = win.getBounds();
      const from = f.lines.length;
      win.setBounds({ ...b, x: b.x + 40 });
      await f.wait((j) => Array.isArray(j.wins) && j.wins.some((w) => w.hwnd === ourId && Math.abs(w.x - (b.x + 40)) <= 2), 4000, from);
      win.setBounds(b);
      f.send('list 8');
      const list = await f.wait((j) => j.id === 8 && Array.isArray(j.list));
      return `front: ${fg.fg.exe} (${fg.fg.kind}); ${list.list.length} windows listed`;
    } finally {
      f.stop();
    }
  });

  // ---- reading and looking ----
  await step('read: the window’s text', async () => {
    const r = await host.request('read', { hwnd: ourId, maxChars: 4000 });
    expect(r.ok, JSON.stringify(r));
    expect(r.lines.some((l) => l.includes('An earlier message')), r.lines.slice(0, 12).join(' | '));
    return `${r.lines.length} lines`;
  });

  await step('selection: selected text', async () => {
    await page("(() => { const p = document.querySelector('article p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()");
    await sleep(200);
    const r = await host.request('selection', { hwnd: ourId });
    expect(r.ok && r.kind === 'text' && /earlier message/.test(r.text), JSON.stringify(r));
  });

  await step('capture + on-device OCR', async () => {
    if (!perms.screen) return 'skipped (Screen Recording is off)';
    const out = path.join(os.tmpdir(), `orbit-e2e-look-${process.pid}.png`);
    const r = await runHelperOnce(['capture', '--window', String(ourId), '--out', out, '--max-width', '1200']);
    expect(r.ok, JSON.stringify(r));
    expect(r.lit > 0.2 && fs.existsSync(out), `lit ${r.lit}`);
    expect(/earlier message/i.test(r.ocr), `ocr: ${String(r.ocr).slice(0, 200)}`);
    if (shotsDir) {
      fs.mkdirSync(shotsDir, { recursive: true });
      fs.copyFileSync(out, path.join(shotsDir, 'mac-e2e-capture.png'));
    }
    fs.rmSync(out, { force: true });
    return `${r.w}×${r.h}, OCR ${String(r.ocr).length} chars (${r.lang})`;
  });

  console.log(`\n${results.length - failed}/${results.length} passed`);
  host.stop();
  win.destroy();
  app.exit(failed ? 1 : 0);
});
