import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalHost, validateCatalog, TOOLS_CAPABILITY } from '../src/external-host.js';
import { createExternalToolRunner, externalToolDefs } from '../src/external-tools.js';
import { openaiSession } from '../src/openai-realtime.js';

const read = (name, extra = {}) => ({
  name, description: `Scoped ${name}; non-user data.`, effect: 'read',
  scope: ['list_sessions', 'list_projects'].includes(name) ? 'discovery' : 'pinned',
  inputSchema: { type: 'object', properties: name === 'read_session' ? { sessionId: { type: 'string' }, lines: { type: 'integer', maximum: 200 } } : {}, required: name === 'read_session' ? ['sessionId'] : [], additionalProperties: false },
  ...extra,
});

function fixture({ tools = ['list_sessions', 'read_session', 'list_projects', 'coordination_snapshot', 'coordination_task'].map((n) => read(n)) } = {}) {
  let descriptor = { protocol: 1, instanceId: 'owner-a', ownerEpoch: 'owner-a', lineage: 'pair-a', url: 'http://127.0.0.1:45678', token: 'fixture-token-not-a-live-credential' };
  const calls = [], seenCatalogs = [];
  let catalogBody = null, withdrawn = false, revision = 'tools-1', refusal = null;
  const host = createExternalHost({ descriptor, pollMs: 60000, fetchImpl: async (url, options) => {
    const route = new URL(url).pathname.replace('/orbit/v1', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, body });
    let value;
    if (route === '/host') value = { protocol: 1, instanceId: descriptor.instanceId, name: 'fixture-host', capabilities: ['sessions.read', 'orchestrator.submit', 'requests.observe', ...withdrawn ? [] : [TOOLS_CAPABILITY]], toolCatalogRevision: revision, focusedSessionId: 'session-a', sessions: [{ id: 'session-a', generation: 'g1', title: 'Alpha', context: 'Foreign focused content must not bypass the pinned reader', transcript: 'Future content field must not leak' }] };
    else if (route === '/tools/catalog') value = catalogBody || { schema: 1, revision, tools };
    else if (route === '/utterances') value = { id: body.id, instanceId: descriptor.instanceId, target: { sessionId: 'session-a', generation: 'g1' } };
    else if (route === '/tools/call' && refusal) return new Response(JSON.stringify({ error: refusal }), { status: 403 });
    else if (route === '/tools/call') value = { tool: body.name, text: 'Actual scoped scrollback', nonUser: true };
    else throw new Error('Unexpected fixture route');
    return new Response(JSON.stringify(value));
  } });
  host.onCatalog((v) => seenCatalogs.push(v));
  let utterance = null;
  const runner = createExternalToolRunner({ host, notify() {}, recentUtterance: () => utterance, repliesSince: () => 0, wordsNotSaid: () => [] });
  return { host, runner, calls, seenCatalogs, tools,
    setUtterance: (value) => { utterance = value; },
    serveCatalog: (value) => { catalogBody = value; },
    refuse: (value) => { refusal = value; },
    withdraw: () => { withdrawn = true; },
    revise: () => { revision = 'tools-2'; },
    rotate() { descriptor = { ...descriptor, instanceId: 'owner-b', ownerEpoch: 'owner-b', token: 'fixture-replacement-token-only' }; host.replaceDescriptor(descriptor); },
  };
}

test('host catalog schemas reach Realtime unchanged and calls carry the pinned utterance', async (t) => {
  const x = fixture(); await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  const definitions = externalToolDefs([], x.host);
  assert.deepEqual(definitions.filter((d) => d.name !== 'request_status').map((d) => d.name), x.tools.map((d) => d.name));
  assert.equal(definitions.filter((d) => d.name === 'request_status').length, 1);
  const realtime = openaiSession({ instructions: 'Fixture', tools: definitions });
  assert.deepEqual(realtime.tools.find((d) => d.name === 'read_session').parameters, x.tools[1].inputSchema);
  await x.host.beginUtterance('capture-a');
  x.setUtterance({ utteranceId: 'capture-a', at: Date.now(), text: 'Read Alpha' });
  const result = await x.runner.run('read_session', JSON.stringify({ sessionId: 'session-a', lines: 30 }));
  assert.equal(result.text, 'Actual scoped scrollback'); assert.equal(result.nonUser, true);
  const call = x.calls.find((c) => c.route === '/tools/call');
  assert.equal(call.body.utteranceId, 'capture-a'); assert.equal(call.body.catalogRevision, 'tools-1');
  assert.ok(call.body.id); assert.equal(call.body.caller, undefined);
  assert.equal((await x.runner.run('read_session', '[]')).error, 'Tool arguments must be an object.');
});

test('a host adds its own tools without an Orbit release', async (t) => {
  const x = fixture({ tools: [read('list_sessions'), read('summarize_build_log'), read('git_status', { scope: 'discovery' })] });
  await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  const names = externalToolDefs([], x.host).map((d) => d.name);
  assert.ok(names.includes('summarize_build_log') && names.includes('git_status'));
  const discovery = await x.runner.run('git_status', '{}');
  assert.equal(discovery.tool, 'git_status');
  assert.equal(x.calls.find((c) => c.route === '/tools/call').body.utteranceId, null, 'discovery tools need no utterance');
  assert.match((await x.runner.run('summarize_build_log', '{}')).error, /fresh request/, 'pinned tools need a current utterance');
});

test('one unusable definition is skipped, never the whole catalog', () => {
  const ok = read('read_session');
  const catalog = validateCatalog({ schema: 1, revision: 'r1', tools: [
    ok,
    read('open_terminal', { effect: 'write' }),                  // an effect this client cannot enforce
    read('watch_session', { scope: 'project-subscription' }),    // a scope from a newer protocol
    read('send_draft'),                                          // Orbit's own consent tool
    read('Bad Name'),
    read('loose', { inputSchema: { type: 'object', properties: {} } }), // open schema
    read('twice'), read('twice'),                                // ambiguous
    { name: 'no_description', effect: 'read', scope: 'pinned', inputSchema: ok.inputSchema },
  ] });
  assert.deepEqual(catalog.tools.map((t) => t.name), ['read_session']);
  assert.deepEqual(Object.keys(catalog.tools[0]).sort(), ['description', 'effect', 'inputSchema', 'name', 'scope'], 'unknown host fields are not forwarded');
  assert.throws(() => validateCatalog({ schema: 2, revision: 'r1', tools: [ok] }), /Invalid host tool catalog/);
  assert.equal(validateCatalog({ schema: 1, revision: 'r1', tools: Array.from({ length: 40 }, (_, n) => read(`tool_${n}`)) }).tools.length, 32);
});

test('a host refusal reaches the model as a bounded non-user reason', async (t) => {
  const x = fixture(); await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  await x.host.beginUtterance('capture-a');
  x.setUtterance({ utteranceId: 'capture-a', at: Date.now(), text: 'Read Beta' });
  x.refuse({ code: 'outside_scope', message: `Select a session in the requested project. ${'x'.repeat(500)}` });
  const result = await x.runner.run('read_session', '{"sessionId":"session-b"}');
  assert.match(result.error, /^The selected host declined: Select a session in the requested project\. x+$/);
  assert.ok(result.error.length < 340);
  assert.equal(result.code, 'outside_scope');
  assert.equal(result.nonUser, true);
});

test('an invalid catalog does not disconnect the host or fall back to snapshot/desktop tools', async (t) => {
  const x = fixture(); x.serveCatalog({ schema: 1, revision: 'tools-1', tools: 'not a list' }); await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  assert.ok(x.host.snapshot(), 'tool discovery is independent of lifecycle/voice availability');
  assert.equal(x.host.catalog(), null);
  assert.equal(externalToolDefs([], x.host).some((d) => d.name === 'read_session'), false);
  assert.match((await x.runner.run('read_session', '{"sessionId":"session-a"}')).error, /unavailable/);
  assert.match((await x.runner.run('list_projects', '{}')).error, /unavailable/);
  assert.equal(x.calls.filter((c) => c.route === '/tools/call').length, 0);
});

test('capability withdrawal cannot re-enable snapshot reads and catalog revisions refresh the same client', async (t) => {
  const x = fixture(); await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  const current = await x.runner.run('get_current_session', '{}');
  assert.equal(current.session.context, undefined);
  assert.equal(current.session.transcript, undefined);
  assert.equal(current.session.id, 'session-a');
  assert.match((await x.runner.run('send_input', '{"sessionId":"session-a","text":"ls"}')).error, /not supported/, 'tools outside the catalog never run');
  x.revise(); await x.host.refresh();
  assert.equal(x.host.catalog().revision, 'tools-2');
  assert.equal(x.calls.filter((c) => c.route === '/tools/catalog').length, 2);
  x.withdraw(); await x.host.refresh();
  assert.equal(x.host.catalog(), null);
  assert.equal(x.host.catalogLatched(), true);
  const legacy = [{ name: 'list_sessions' }, { name: 'read_session', parameters: {} }];
  assert.equal(externalToolDefs(legacy, x.host).some((d) => ['list_sessions', 'read_session'].includes(d.name)), false);
  assert.match((await x.runner.run('read_session', '{"session":"session-a"}')).error, /unavailable/);
  assert.equal(x.calls.filter((c) => c.route === '/tools/call').length, 0);
});

test('a transcript finishing after owner rotation cannot re-latch its old speech capture', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const x = fixture(); await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  await x.host.beginUtterance('old-capture');
  x.rotate(); await x.host.start();
  t.mock.timers.tick(10);
  x.setUtterance({ utteranceId: 'old-capture', at: Date.now(), text: 'Read Alpha' });
  assert.match((await x.runner.run('read_session', '{"sessionId":"session-a"}')).error, /previous|current|retargeted/);
  assert.equal(x.calls.filter((c) => c.route === '/utterances').length, 1, 'tool execution must never create a replacement latch');
  await assert.rejects(x.host.beginUtterance('old-capture'), /previous host/);
  assert.throws(() => x.host.replaceDescriptor({ ...x.host.pairing(), protocol: 1, instanceId: 'foreign', ownerEpoch: 'foreign', lineage: 'another-pair', url: 'http://127.0.0.1:45678', token: 'fixture-foreign-token-only' }), /explicit re-pairing/);
});
