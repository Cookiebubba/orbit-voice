// Text that web apps take (src/anywhere/hands.js, cdp.js): the order of the ways to type, and the
// DevTools path's rules (local only, the window's own page, only the calls it needs), without a real app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cdpType, portFromCommandLine } from '../src/anywhere/cdp.js';
import { inputOrder } from '../src/anywhere/hands.js';

test('the ways to type, in order: what worked last time first; borrowing focus only with the user\x27s OK', () => {
  assert.deepEqual(inputOrder(null), ['value']);
  assert.deepEqual(inputOrder(null, { cdpOn: true }), ['value', 'cdp']);
  assert.deepEqual(inputOrder({ inputMethod: 'cdp' }, { cdpOn: true }), ['cdp', 'value']);
  assert.deepEqual(inputOrder({ inputMethod: 'borrow' }), ['value'], 'remembered, but no OK on file: never borrowed');
  assert.deepEqual(inputOrder({ inputMethod: 'borrow', borrowFocusOk: true }), ['borrow', 'value']);
  assert.deepEqual(inputOrder(null, { borrowOk: true }), ['value', 'borrow']);
  assert.deepEqual(inputOrder({ inputMethod: 'nonsense' }), ['value']);
});

test('the debugging port comes only from the app\x27s own command line', () => {
  assert.equal(portFromCommandLine('"C:\\app\\app.exe" --remote-debugging-port=9222 --foo'), 9222);
  assert.equal(portFromCommandLine('app.exe --remote-debugging-port 9333'), 9333);
  assert.equal(portFromCommandLine('app.exe --inspect=9229'), 0);
  assert.equal(portFromCommandLine(''), 0);
  assert.equal(portFromCommandLine('app.exe --remote-debugging-port=99999'), 0);
});

/** A fake page: answers the calls cdpType makes, and records them. */
function fakeWs(record, { axFound = true } = {}) {
  return class extends EventEmitter {
    constructor(url) {
      super();
      record.url = url;
      setImmediate(() => this.emit('open'));
    }
    send(raw) {
      const m = JSON.parse(raw);
      record.calls.push(m.method);
      record.params.push(m.params);
      const result = m.method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : m.method === 'Accessibility.queryAXTree' ? { nodes: axFound ? [{ backendDOMNodeId: 7 }] : [] } : m.method === 'DOM.querySelector' ? { nodeId: 9 } : {};
      setImmediate(() => this.emit('message', JSON.stringify({ id: m.id, result })));
    }
    close() {}
  };
}

test('typing through the debugging port: the window\x27s own page, focus the box, then insert the text', async () => {
  const record = { calls: [], params: [] };
  const pages = [
    { type: 'page', title: 'Something else', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/A' },
    { type: 'page', title: 'My App', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/B' },
    { type: 'page', title: 'Evil', webSocketDebuggerUrl: 'ws://203.0.113.5:9222/devtools/page/C' },
  ];
  const fetchImpl = async (url) => {
    assert.equal(url, 'http://127.0.0.1:9222/json/list', 'only this PC');
    return { json: async () => pages };
  };
  const r = await cdpType({ pid: 1, title: 'My App - Profile 1 - Browser' }, { name: 'Prompt', text: 'hello', port: 9222, fetchImpl, Ws: fakeWs(record) });
  assert.deepEqual(r, { ok: true, via: 'cdp' });
  assert.match(record.url, /page\/B$/, 'the page whose title the window starts with');
  assert.deepEqual(record.calls, ['DOM.getDocument', 'Accessibility.queryAXTree', 'DOM.focus', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
  assert.ok(!record.calls.some((c) => /Runtime|evaluate|Page\.|Target\./.test(c)), 'never runs code in the page');
  assert.deepEqual(record.params[2], { backendNodeId: 7 });
  assert.deepEqual(record.params.at(-1), { text: 'hello' });
  // No box by accessible name: found by the attributes that name it instead (a CSS string, escaped).
  const r2 = { calls: [], params: [] };
  const ok2 = await cdpType({ pid: 1, title: 'My App' }, { name: 'Say "hi"', text: 'x', port: 9222, fetchImpl, Ws: fakeWs(r2, { axFound: false }) });
  assert.equal(ok2.ok, true);
  assert.equal(r2.params.find((p) => p?.selector)?.selector, '[aria-label="Say \\"hi\\""]');
  // No port on the command line: nothing at all.
  assert.equal((await cdpType({ pid: 1, title: 'x' }, { name: 'a', text: 'b', cmdline: async () => 'app.exe' })).error, 'no_port');
});
