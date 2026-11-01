import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalHost } from '../src/external-host.js';
import { createExternalToolRunner, externalToolDefs } from '../src/external-tools.js';
import { openaiSession } from '../src/openai-realtime.js';

function fixture() {
  let descriptor = { protocol: 1, instanceId: 'owner-a', ownerEpoch: 'owner-a', lineage: 'pair-a', url: 'http://127.0.0.1:45678', token: 'fixture-token-not-a-live-credential' };
  const calls = [], seenCatalogs = [];
  let broken = false, withdrawn = false, revision = 'tools-1';
  const tools = ['list_sessions', 'read_session', 'list_projects', 'coordination_snapshot', 'coordination_task'].map((name) => ({
    name, description: `Scoped ${name}; non-user data.`, schemaVersion: 1, capability: 'bro.tools.v1', effect: 'read',
    scope: ['list_sessions', 'list_projects'].includes(name) ? 'discovery' : 'pinned-project',
    inputSchema: { type: 'object', properties: name === 'read_session' ? { sessionId: { type: 'string' }, lines: { type: 'integer', maximum: 200 } } : {}, required: name === 'read_session' ? ['sessionId'] : [], additionalProperties: false },
  }));
  const host = createExternalHost({ descriptor, pollMs: 60000, fetchImpl: async (url, options) => {
    const route = new URL(url).pathname.replace('/orbit/v1', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, body });
    let value;
    if (route === '/host') value = { protocol: 1, instanceId: descriptor.instanceId, capabilities: ['sessions.read', 'orchestrator.submit', 'requests.observe', ...withdrawn ? [] : ['bro.tools.v1']], toolCatalogRevision: revision, focusedSessionId: 'session-a', sessions: [{ id: 'session-a', generation: 'g1', title: 'Alpha', context: 'Foreign focused content must not bypass the pinned reader', transcript: 'Future content field must not leak' }] };
    else if (route === '/tools') value = { schema: 1, revision, tools: broken ? [{ ...tools[0], name: 'send_input' }] : tools };
    else if (route === '/utterances') value = { id: body.id, instanceId: descriptor.instanceId, target: { sessionId: 'session-a', generation: 'g1' } };
    else if (route === '/tools/read') value = { sessionId: 'session-a', text: 'Actual scoped scrollback', nonUser: true };
    else throw new Error('Unexpected fixture route');
    return new Response(JSON.stringify(value));
  } });
  host.onCatalog((v) => seenCatalogs.push(v));
  let utterance = null;
  const runner = createExternalToolRunner({ host, notify() {}, recentUtterance: () => utterance, repliesSince: () => 0, wordsNotSaid: () => [] });
  return { host, runner, calls, seenCatalogs, tools,
    setUtterance: (value) => { utterance = value; },
    breakCatalog: () => { broken = true; },
    withdraw: () => { withdrawn = true; },
    revise: () => { revision = 'tools-2'; },
    rotate() { descriptor = { ...descriptor, instanceId: 'owner-b', ownerEpoch: 'owner-b', token: 'fixture-replacement-token-only' }; host.replaceDescriptor(descriptor); },
  };
}

test('reviewed canonical schemas reach Realtime unchanged and real reads use the scoped host adapter', async (t) => {
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
  const call = x.calls.find((c) => c.route === '/tools/read');
  assert.equal(call.body.utteranceId, 'capture-a'); assert.equal(call.body.catalogRevision, 'tools-1');
  assert.ok(call.body.id); assert.equal(call.body.caller, undefined);
  assert.equal((await x.runner.run('read_session', '[]')).error, 'Tool arguments must be an object.');
});

test('an unsupported catalog does not disconnect the host or fall back to summary/desktop tools', async (t) => {
  const x = fixture(); x.breakCatalog(); await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  assert.ok(x.host.snapshot(), 'tool discovery is independent of lifecycle/voice availability');
  assert.equal(x.host.catalog(), null);
  assert.equal(externalToolDefs([], x.host).some((d) => d.name === 'send_input' || d.name === 'read_session'), false);
  assert.match((await x.runner.run('read_session', '{"sessionId":"session-a"}')).error, /unavailable/);
  assert.equal(x.calls.filter((c) => c.route === '/tools/read').length, 0);
});

test('capability withdrawal cannot re-enable cached/legacy reads and catalog revisions refresh the same client', async (t) => {
  const x = fixture(); await x.host.start(); t.after(() => { x.runner.dispose(); x.host.stop(); });
  const current = await x.runner.run('get_current_session', '{}');
  assert.equal(current.session.context, undefined);
  assert.equal(current.session.transcript, undefined);
  assert.equal(current.session.id, 'session-a');
  x.revise(); await x.host.refresh();
  assert.equal(x.host.catalog().revision, 'tools-2');
  assert.equal(x.calls.filter((c) => c.route === '/tools').length, 2);
  x.withdraw(); await x.host.refresh();
  assert.equal(x.host.catalog(), null);
  assert.equal(x.host.reviewedToolsRequired(), true);
  const legacy = [{ name: 'list_sessions' }, { name: 'read_session', parameters: {} }];
  assert.equal(externalToolDefs(legacy, x.host).some((d) => ['list_sessions', 'read_session'].includes(d.name)), false);
  assert.match((await x.runner.run('read_session', '{"session":"session-a"}')).error, /unavailable/);
  assert.equal(x.calls.filter((c) => c.route === '/tools/read').length, 0);
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
