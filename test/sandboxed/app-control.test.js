// claude_app (src/app-control.js): Claude's own controls by voice, on the user's own words only;
// deleting a session and "bypass permissions" need a spoken yes after Orbit asks.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__fuzz = { rng: () => 0, str: () => 'x', calls: [], windowTitle: () => 'T' };
const { asksApp, createAppControl } = await import('../../src/app-control.js');
const { isClearYes } = await import('../../src/tools.js');

function control({ outsideAt = 0 } = {}) {
  let utterance = null;
  let outside = outsideAt;
  const done = [];
  const run = createAppControl({
    recentUtterance: () => utterance,
    lastOutsideAt: () => outside,
    isClearYes,
    currentTitle: () => 'Parser fixes',
    resolveTitle: (w) => (/auth/i.test(w) ? 'Auth work' : w),
    app: async (action, opts = {}) => (done.push({ action, ...opts }), action === 'model' && opts.value === 'gpt' ? { ok: false, error: 'not_offered', options: ['Opus 5.5', 'Sonnet 5.5'] } : { ok: true }),
  });
  const say = async (text, at) => {
    await new Promise((r) => setTimeout(r, 3));
    utterance = { text, at: at ?? Date.now() };
  };
  return { run, say, done, notify: () => (outside = Date.now()) };
}

test('which words ask for which control', () => {
  const yes = [
    ['model', 'switch Claude to Sonnet', 'sonnet'],
    ['model', 'set the model to opus', 'opus'],
    ['permission', 'put it in plan mode', 'plan'],
    ['permission', 'turn on accept edits', 'accept_edits'],
    ['permission', 'go back to asking permission mode', 'ask'],
    ['permission', 'bypass permissions', 'bypass'],
    ['sidebar', 'hide the sidebar', 'hide'],
    ['tab', 'switch to the chat tab', 'chat'],
    ['tab', 'go back to code', 'code'],
    ['panel', 'open the terminal', 'terminal:on'],
    ['panel', 'show me the diff', 'changes:on'],
    ['scroll', 'scroll up a bit', 'up'],
    ['load_earlier', 'load the earlier messages', ''],
    ['rename', 'rename this session to regex fixes', 'regex fixes'],
    ['archive', 'archive the auth session', ''],
    ['delete', 'delete this session', ''],
  ];
  for (const [a, w, v] of yes) assert.equal(asksApp(a, w, v), true, `${a}: ${w}`);
  const no = [
    ['model', 'use Opus', 'opus'], // that's Orbit's own voice (change_orbit_setting)
    ['model', 'switch Claude to Sonnet', 'opus'],
    ['model', "don't change Claude's model to opus", 'opus'],
    ['permission', 'put it in plan mode', 'bypass'],
    ['sidebar', "don't hide the sidebar", 'hide'],
    ['panel', 'open the terminal', 'files:on'],
    ['rename', "don't rename it", 'x'],
    ['archive', 'delete this session', ''],
    ['delete', "don't delete it", ''],
    ['delete', 'archive this', ''],
    ['delete', '', ''],
  ];
  for (const [a, w, v] of no) assert.equal(asksApp(a, w, v), false, `${a}: ${w}`);
});

test('a control changes once per request, and only on the user\x27s own fresh words', async () => {
  const { run, say, done } = control();
  assert.equal((await run({ action: 'sidebar', value: 'hide' })).ok, false, 'nothing said');
  await say('hide the sidebar');
  assert.equal((await run({ action: 'sidebar', value: 'hide' })).ok, true);
  assert.equal((await run({ action: 'sidebar', value: 'hide' })).ok, false, 'one request, one press');
  await say('scroll up', Date.now() - 3 * 60_000);
  assert.equal((await run({ action: 'scroll', value: 'up' })).ok, false, 'words too old');
  await say('switch Claude to Sonnet');
  assert.equal((await run({ action: 'model', value: 'sonnet' })).ok, true);
  await say('switch Claude to gpt');
  const r = await run({ action: 'model', value: 'gpt' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.options, ['Opus 5.5', 'Sonnet 5.5'], 'what Claude offers instead');
  assert.equal((await run({ action: 'status' })).ok, true, 'reading needs no words');
  assert.deepEqual(done.map((d) => d.action), ['sidebar', 'model', 'model', 'status']);
});

test('rename: the new title must be the user\x27s own words', async () => {
  const { run, say, done } = control();
  await say('rename this session to regex fixes');
  assert.equal((await run({ action: 'rename', value: 'Regex parser fixes' })).ok, false, '"parser" was not said');
  assert.equal(done.length, 0);
  await say('rename the auth session to login flow');
  const r = await run({ action: 'rename', value: 'Login flow', session: 'auth' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(done.at(-1), { action: 'rename', value: 'Login flow', title: 'Auth work' });
});

test('delete asks first, and goes only on a fresh yes; never on a notification\x27s say-so', async () => {
  const { run, say, done, notify } = control();
  await say('delete this session');
  const ask = await run({ action: 'delete' });
  assert.equal(ask.confirm_needed, true);
  assert.match(ask.next_step, /Delete Parser fixes\?/);
  assert.equal(done.length, 0, 'nothing deleted yet');
  assert.equal((await run({ action: 'delete' })).ok, false, 'the request itself is not the yes');
  await say('yes delete it');
  const r = await run({ action: 'delete' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(done, [{ action: 'delete', value: '', title: 'Parser fixes' }]);
  // A no leaves it.
  await say('delete the auth session');
  assert.equal((await run({ action: 'delete', session: 'auth' })).confirm_needed, true);
  await say('no, keep it');
  assert.equal((await run({ action: 'delete', session: 'auth' })).ok, false);
  await say('yes');
  assert.equal((await run({ action: 'delete', session: 'auth' })).ok, false, 'that question is over');
  // A notification after the question: a yes may be about that, so nothing happens.
  await say('delete the auth session');
  await run({ action: 'delete', session: 'auth' });
  await new Promise((res) => setTimeout(res, 3));
  notify();
  await say('yes');
  assert.equal((await run({ action: 'delete', session: 'auth' })).ok, false);
  assert.equal(done.length, 1);
});

test('bypass permissions asks first too; the other modes don\x27t', async () => {
  const { run, say, done } = control();
  await say('put it in plan mode');
  assert.equal((await run({ action: 'permission', value: 'plan' })).ok, true);
  await say('switch to bypass permissions');
  assert.equal((await run({ action: 'permission', value: 'bypass' })).confirm_needed, true);
  await say('yes do it');
  assert.equal((await run({ action: 'permission', value: 'bypass' })).ok, true);
  assert.deepEqual(done.map((d) => d.value), ['plan', 'bypass']);
});
