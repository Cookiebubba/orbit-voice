// Preload boundary only: no Electron process, OS input, microphone or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  let desktop;
  const sent = [], listeners = new Map();
  const ipcRenderer = {
    send: (...args) => sent.push(JSON.parse(JSON.stringify(args))),
    on: (name, callback) => listeners.set(name, callback),
    removeListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: 'win32', argv: [] },
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktop'); desktop = value; } } };
    },
  });
  return { desktop, sent, listeners };
}

test('avatar hit reports retain movement revision while fixed pages keep revision zero', () => {
  const f = fixture();
  f.desktop.buddyHit({ x: 10, y: 20, w: 30, h: 40, revision: 7, unrelated: 'not forwarded' });
  assert.deepEqual(f.sent.pop(), ['buddy:hit', { x: 10, y: 20, w: 30, h: 40, revision: 7 }]);
  f.desktop.buddyHit({ x: 10, y: 20, w: 30, h: 40 });
  assert.equal(f.sent.pop()[1].revision, 0);
  f.desktop.buddyHit(null);
  assert.deepEqual(f.sent.pop(), ['buddy:hit', null]);
});

test('gesture bridge exposes only phase, identity and movement revision', () => {
  const f = fixture();
  f.desktop.buddyGesture({ phase: 'begin', id: 'gesture-1', revision: 5, command: 'not forwarded' });
  assert.deepEqual(f.sent.pop(), ['buddy:gesture', { phase: 'begin', id: 'gesture-1', revision: 5 }]);
  f.desktop.buddyGesture(null);
  assert.deepEqual(f.sent.pop(), ['buddy:gesture', null]);
});

test('native gesture subscription is removable and never generates talk or a new press', () => {
  const f = fixture(), received = [];
  const unsubscribe = f.desktop.onBuddyGesture((sample) => received.push(sample));
  const sample = { id: 'gesture-1', sequence: 4, revision: 5, x: -10, y: 100, down: false };
  f.listeners.get('buddy:gesture')({}, sample);
  assert.deepEqual(received, [sample]);
  assert.equal(f.sent.length, 0);
  unsubscribe();
  assert.equal(f.listeners.has('buddy:gesture'), false);
});
