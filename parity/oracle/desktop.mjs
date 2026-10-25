// The engine oracle's desktop cases (parity/oracle/gen.mjs): the macOS port's Claude driver
// (src/platform/mac/desktop.js) run against the stand-in Claude (test/fixtures/mac-claude.js) through
// many scenarios, every request it sends to the helper and every answer recorded, with each result.
// The Swift driver is given the same answers in the same order and must send the same requests and
// come to the same results. (Answers that repeat are kept once: `responses`, by index.)
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

export async function desktopFixtures(root) {
  const load = (...rel) => import(pathToFileURL(path.join(root, ...rel)).href);
  const { createMacDesktop } = await load('src', 'platform', 'mac', 'desktop.js');
  const { createFakeClaude } = await load('test', 'fixtures', 'mac-claude.js');

  const responses = [];
  const seen = new Map();
  const keep = (res) => {
    const text = JSON.stringify(res ?? null);
    if (!seen.has(text)) {
      seen.set(text, responses.length);
      responses.push(JSON.parse(text));
    }
    return seen.get(text);
  };

  /** One scenario: a request function (from fakes), then steps run in order on it. */
  async function scenario(name, request, steps, { onlyPid = 0, patch = () => {} } = {}) {
    patch();
    const out = [];
    for (const step of steps) {
      if (step.patch) step.patch();
      const log = [];
      const d = createMacDesktop({
        onlyPid,
        sleep: () => Promise.resolve(),
        request: async (op, args) => {
          const res = await request(op, args);
          log.push({ op, args: JSON.parse(JSON.stringify(args ?? {})), r: keep(res) });
          return res;
        },
      });
      let result;
      try {
        result = await d.run(step.mode, step.args || []);
      } catch (e) {
        result = { threw: String(e?.message || e) };
      }
      out.push({ mode: step.mode, args: step.args || [], requests: log, result: JSON.parse(JSON.stringify(result)) });
    }
    return { name, onlyPid, steps: out };
  }

  const single = (opts = {}, tweak = () => {}) => {
    const c = createFakeClaude(opts);
    tweak(c.state);
    return c;
  };

  const all = [];
  const run = async (name, opts, steps, tweak) => {
    const c = single(opts, tweak);
    all.push(await scenario(name, (op, a) => c.request(op, a), typeof steps === 'function' ? steps(c) : steps));
  };

  // Reading.
  await run('info', {}, [{ mode: 'info', args: ['-Rects', '-FrontHwnd', '359'] }, { mode: 'info', args: [] }, { mode: 'info', args: ['-FrontHwnd', '999'] }, { mode: 'list' }]);
  await run('info working', { working: true }, [{ mode: 'info', args: ['-Rects'] }, { mode: 'list' }]);
  await run('info new session', { open: null }, [{ mode: 'info', args: ['-Rects'] }, { mode: 'list' }], (s) => (s.newFolder = 'Fire'));
  await run('info minimized', { minimized: true }, [{ mode: 'info' }, { mode: 'list' }]);
  await run('a typed box', {}, [{ mode: 'info', args: ['-Rects'] }], (s) => (s.box = 'half a thought /'));
  await run('a slash box', {}, [{ mode: 'info' }], (s) => (s.box = '/ \n'));
  await run('many sessions', { sessions: ['A', 'B', 'B two', 'Write things', 'Fix the login bug'], open: 'B' }, [{ mode: 'list' }, { mode: 'info' }]);

  // Switching.
  await run('switch', {}, [
    { mode: 'switch', args: ['-TitleB64', b64('release notes')] },
    { mode: 'switch', args: ['-TitleB64', b64('Write the release notes')] },
    { mode: 'switch', args: ['-TitleB64', b64('no such session')] },
    { mode: 'switch', args: ['-TitleB64', b64('  ')] },
    { mode: 'switch', args: ['-TitleB64', b64('PLAN')] },
    { mode: 'switch', args: [] },
  ]);
  await run('switch with a draft', {}, [{ mode: 'switch', args: ['-TitleB64', b64('Plan viewer alpha')] }], (s) => (s.box = 'draft'));
  await run('switch hidden sidebar', {}, [{ mode: 'switch', args: ['-TitleB64', b64('Plan viewer alpha')] }], (s) => (s.sidebar = false));

  // New sessions.
  await run('new', {}, [{ mode: 'new' }, { mode: 'new' }, { mode: 'info' }]);
  await run('new in a folder', {}, [
    { mode: 'new', args: ['-ProjectB64', b64('ladder 6')] },
    { mode: 'new', args: ['-ProjectB64', b64('nowhere')] },
  ]);
  await run('new folder variants', { folders: [['Fire', 'ladder 6'], ['Fire', 'other'], ['orbit-voice', ''], ['orbit', 'x']] }, [
    { mode: 'new', args: ['-ProjectB64', b64('fire')] },
    { mode: 'new', args: ['-ProjectB64', b64('orbit')] },
    { mode: 'new', args: ['-ProjectB64', b64('x')] },
  ]);
  await run('new with text in the box', {}, [{ mode: 'new' }], (s) => (s.box = 'keep me'));
  await run('new without a sidebar', {}, [{ mode: 'new' }], (s) => (s.sidebar = false));

  // Sending.
  await run('send', {}, [
    { mode: 'send', args: ['-TextB64', b64('Please run the tests'), '-ExpectTitleB64', b64('Fix the login bug')] },
    { mode: 'send', args: ['-TextB64', b64('next one')] },
  ]);
  await run('send to another session', {}, [{ mode: 'send', args: ['-TextB64', b64('hello'), '-ExpectTitleB64', b64('Some other session')] }]);
  await run('send over typed text', {}, [{ mode: 'send', args: ['-TextB64', b64('hello')] }], (s) => (s.box = 'the user is typing'));
  await run('send refused', {}, [{ mode: 'send', args: ['-TextB64', b64('hello there')] }], (s) => (s.rejectSetValue = true));
  await run('send while working', { working: true }, [{ mode: 'send', args: ['-TextB64', b64('next step')] }]);
  await run('fill then revise then send', {}, (c) => [
    { mode: 'send', args: ['-TextB64', b64('draft one'), '-Fill'] },
    { mode: 'send', args: ['-TextB64', b64('draft two'), '-Fill', '-PrevB64', b64('draft one')] },
    { mode: 'send', args: ['-TextB64', b64('draft three'), '-Fill', '-PrevB64', b64('not what is there')] },
    { mode: 'send', args: ['-TextB64', b64('draft two'), '-Filled'] },
    { mode: 'send', args: ['-TextB64', b64('draft two'), '-Clear'], patch: () => ((c.state.box = 'edited by the user'), (c.state.working = false)) },
    { mode: 'send', args: ['-TextB64', b64('edited by the user'), '-Clear'] },
    { mode: 'send', args: ['-TextB64', b64('gone'), '-Filled'] },
  ]);
  await run('dry run', {}, [{ mode: 'send', args: ['-TextB64', b64('just checking'), '-DryRun'] }]);
  await run('send empty', {}, [{ mode: 'send', args: ['-TextB64', b64('   ')] }, { mode: 'send', args: [] }]);
  await run('send multi-line', {}, [{ mode: 'send', args: ['-TextB64', b64('First line of a long prompt that goes on and on\nsecond line\n  third')] }]);
  await run('send to a new session', { open: null }, (c) => [
    { mode: 'send', args: ['-TextB64', b64('start here'), '-ExpectNew', '-ExpectFolderB64', b64('Fire')], patch: () => (c.state.newFolder = 'orbit-voice') },
    { mode: 'send', args: ['-TextB64', b64('start here'), '-ExpectNew', '-ExpectFolderB64', b64('orbit-voice')] },
  ]);
  await run('send to a new session, any folder', { open: null }, [{ mode: 'send', args: ['-TextB64', b64('start'), '-ExpectNew'] }], (s) => (s.newFolder = 'Fire'));

  // Stop.
  await run('stop', { working: true }, [{ mode: 'stop' }, { mode: 'stop' }, { mode: 'stop', args: ['-ExpectTitleB64', b64('Nope')] }]);

  // Cards.
  await run('permission', { card: { kind: 'permission', title: 'Allow Claude to run a command?', command: 'npm test' } }, (c) => [
    { mode: 'pending' },
    { mode: 'answer', args: ['-KeyB64', b64('0000'), '-Choice', 'allow_once'] },
    { mode: 'answer', args: ['-KeyB64', b64('KEY'), '-Choice', 'deny'], patch: () => {} },
  ]);
  // (A real key: read it, then answer with it, each choice on its own card.)
  for (const choice of ['allow_once', 'allow_always', 'deny', 'allow_session', 'skip', 'bogus']) {
    const c = single({ card: { kind: 'permission', title: 'Allow Claude to edit files?', command: 'edit src/app.js', buttons: ['Allow once', 'Allow for this session', 'Always allow', 'Deny'] } });
    const req = (op, a) => c.request(op, a);
    const p = await createMacDesktop({ request: req, sleep: () => Promise.resolve() }).run('pending', []);
    all.push(await scenario(`answer ${choice}`, req, [{ mode: 'pending' }, { mode: 'answer', args: ['-KeyB64', b64(p.pending?.key || ''), '-Choice', choice] }, { mode: 'pending' }]));
  }
  for (const [label, card, args] of [
    ['option 2', { kind: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] }, ['-Choice', 'option', '-Option', '2']],
    ['option 3 of 2', { kind: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] }, ['-Choice', 'option', '-Option', '3']],
    ['option junk', { kind: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] }, ['-Choice', 'option', '-Option', 'x']],
    ['skip', { kind: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] }, ['-Choice', 'skip']],
    ['allow on a question', { kind: 'question', question: 'Which database?', options: ['Postgres', 'SQLite'] }, ['-Choice', 'allow_once']],
    ['multi', { kind: 'question', question: 'Which tools?', options: ['Lint', 'Test', 'Build'], multi: true }, ['-Choice', 'option', '-Option', '1']],
    ['already picked', { kind: 'question', question: 'Pick one', options: ['A', 'B'], picked: 0 }, ['-Choice', 'option', '-Option', '1']],
  ]) {
    const c = single({ card });
    const req = (op, a) => c.request(op, a);
    const p = await createMacDesktop({ request: req, sleep: () => Promise.resolve() }).run('pending', []);
    all.push(await scenario(`question ${label}`, req, [{ mode: 'pending' }, { mode: 'answer', args: ['-KeyB64', b64(p.pending?.key || ''), ...args] }]));
  }
  await run('nothing pending', {}, [{ mode: 'pending' }, { mode: 'answer', args: ['-KeyB64', b64('abc'), '-Choice', 'deny'] }, { mode: 'pending', args: ['-ExpectTitleB64', b64('Not open')] }]);

  // Claude's own controls.
  await run('app', {}, [
    { mode: 'app', args: ['-Action', 'status'] },
    { mode: 'app', args: ['-Action', 'folders'] },
    { mode: 'app', args: ['-Action', 'model', '-ValueB64', b64('sonnet')] },
    { mode: 'app', args: ['-Action', 'model', '-ValueB64', b64('sonnet')] },
    { mode: 'app', args: ['-Action', 'model', '-ValueB64', b64('opus')] },
    { mode: 'app', args: ['-Action', 'model', '-ValueB64', b64('gpt')] },
    { mode: 'app', args: ['-Action', 'sidebar', '-ValueB64', b64('hide')] },
    { mode: 'app', args: ['-Action', 'sidebar', '-ValueB64', b64('hide')] },
    { mode: 'app', args: ['-Action', 'sidebar'] },
    { mode: 'app', args: ['-Action', 'panel', '-ValueB64', b64('changes:on')] },
    { mode: 'app', args: ['-Action', 'panel', '-ValueB64', b64('terminal')] },
    { mode: 'app', args: ['-Action', 'tab', '-ValueB64', b64('chat')] },
    { mode: 'app', args: ['-Action', 'scroll', '-ValueB64', b64('top')] },
    { mode: 'app', args: ['-Action', 'load_earlier'] },
    { mode: 'app', args: ['-Action', 'permission', '-ValueB64', b64('plan')] },
    { mode: 'app', args: ['-Action', 'permission', '-ValueB64', b64('nonsense')] },
    { mode: 'app', args: ['-Action', 'rename', '-ValueB64', b64('New name')] },
    { mode: 'app', args: ['-Action', 'rename'] },
    { mode: 'app', args: ['-Action', 'archive', '-TitleB64', b64('Plan viewer alpha')] },
    { mode: 'app', args: ['-Action', 'delete', '-TitleB64', b64('Nope')] },
    { mode: 'app', args: ['-Action', 'what'] },
  ]);
  await run('app new session', { open: null }, [{ mode: 'app', args: ['-Action', 'status'] }, { mode: 'app', args: ['-Action', 'folders'] }, { mode: 'app', args: ['-Action', 'rename', '-ValueB64', b64('x')] }]);
  await run('a bad mode', {}, [{ mode: 'nope' }]);

  // Two Claude windows (two sessions open at once).
  {
    const a = single({ hwnd: 359, open: 'Fix the login bug' });
    const b = single({ hwnd: 360, open: 'Write the release notes' });
    let raiseOk = true;
    const request = async (op, args = {}) => {
      if (op === 'windows') {
        const w = (c, z) => ({ hwnd: c.hwnd, pid: 4242, title: 'Claude', min: false, onscreen: true, sr: 'AXStandardWindow', x: 0, y: 0, w: 1200, h: 1040, focused: z === 0, z });
        return { ok: true, running: true, windows: [w(a, 0), w(b, 1), { hwnd: 361, title: 'tiny', w: 50, h: 50 }, { hwnd: 362, title: '', w: 900, h: 900 }, { hwnd: 363, title: 'Panel', w: 900, h: 900, sr: 'AXFloatingWindow' }] };
      }
      if (op === 'raise') return raiseOk ? { ok: true, switched: true } : { ok: true, switched: false };
      const c = args.hwnd === 360 ? b : a;
      return c.request(op, args);
    };
    all.push(await scenario('two windows', request, [
      { mode: 'list' },
      { mode: 'info', args: ['-FrontHwnd', '360'] },
      { mode: 'switch', args: ['-TitleB64', b64('Write the release notes')] },
      { mode: 'switch', args: ['-TitleB64', b64('release')] },
      { mode: 'send', args: ['-TextB64', b64('for the notes'), '-ExpectTitleB64', b64('Write the release notes')] },
      { mode: 'switch', args: ['-TitleB64', b64('Write the release notes')], patch: () => (raiseOk = false) },
      { mode: 'switch', args: ['-TitleB64', b64('Plan viewer alpha')] },
      { mode: 'new' },
    ]));
  }

  // The helper failing.
  all.push(await scenario('not running', async (op) => (op === 'windows' ? { ok: true, running: false, windows: [] } : { ok: false }), [{ mode: 'info' }, { mode: 'list' }]));
  all.push(await scenario('denied', async () => ({ ok: false, error: 'access_denied', message: 'x' }), [{ mode: 'info' }]));
  all.push(await scenario('helper error', async () => ({ ok: false, error: 'failed', message: 'it broke' }), [{ mode: 'send', args: ['-TextB64', b64('x')] }]));
  all.push(await scenario('helper error, no message', async () => ({ ok: false, error: 'timeout' }), [{ mode: 'info' }]));
  all.push(await scenario('no page', async (op) => (op === 'windows' ? { ok: true, running: true, windows: [{ hwnd: 5, title: 'Claude', w: 800, h: 600 }] } : { ok: true, nodes: [{ i: 0, p: -1, t: 'Window', n: 'Claude' }] }), [{ mode: 'info' }]));
  all.push(await scenario('scan fails', async (op) => (op === 'windows' ? { ok: true, running: true, windows: [{ hwnd: 5, title: 'Claude', w: 800, h: 600 }] } : { ok: false, error: 'stale' }), [{ mode: 'list' }]));
  {
    const c = single({});
    all.push(await scenario('only this pid', (op, a) => c.request(op, a), [{ mode: 'info' }], { onlyPid: 4242 }));
  }

  return { responses, scenarios: all };
}
