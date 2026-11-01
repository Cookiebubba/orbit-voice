import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarVoiceStatus, createAvatarClicks } from '../ui/src/buddy/interactions.js';

function clicks() {
  let now = 0, next = 0; const timers = new Map(), calls = [];
  const controller = createAvatarClicks({ single: () => calls.push('talk'), double: () => calls.push('settings'), now: () => now,
    setTimer: (fn, ms) => { timers.set(++next, { fn, at: now + ms }); return next; }, clearTimer: (id) => timers.delete(id) });
  return { controller, calls, step(ms) { now += ms; for (const [id, t] of timers) if (t.at <= now) { timers.delete(id); t.fn(); } } };
}
test('double-click opens settings once and never starts voice', () => {
  const x = clicks(); x.controller.begin(); x.controller.click({ x: 20, y: 20 }); x.step(100);
  x.controller.begin(); x.controller.click({ x: 22, y: 20 }); x.step(1000);
  assert.deepEqual(x.calls, ['settings']);
});
test('single-click keeps Orbit wake behavior and a second grab cancels its deferred wake', () => {
  const x = clicks(); x.controller.click({ x: 20, y: 20 }); x.step(501); assert.deepEqual(x.calls, ['talk']);
  x.controller.click({ x: 20, y: 20 }); x.step(100); x.controller.begin(); x.step(1000); x.controller.cancel();
  assert.deepEqual(x.calls, ['talk']);
});
test('the system double-click interval is honored', () => {
  const x = clicks(); x.controller.setDelay(900); x.controller.click({ x: 20, y: 20 }); x.step(700);
  x.controller.begin(); x.controller.click({ x: 20, y: 20 }); x.step(1000); assert.deepEqual(x.calls, ['settings']);
});
test('mic status follows the actual audio gate, with explicit idempotent Start and Stop actions', () => {
  assert.deepEqual(avatarVoiceStatus({ phase: 'off', microphone: 'off' }), { label: 'Mic off', action: 'start', button: 'Start' });
  assert.equal(avatarVoiceStatus({ phase: 'listening', microphone: 'active', listening: true }).label, 'Listening');
  assert.equal(avatarVoiceStatus({ phase: 'listening', microphone: 'active', muted: true }).label, 'Mic muted');
  assert.equal(avatarVoiceStatus({ phase: 'listening', microphone: 'active', muted: true }).button, 'Unmute');
  assert.equal(avatarVoiceStatus({ phase: 'listening', microphone: 'active', asleep: true }).action, 'start');
  assert.equal(avatarVoiceStatus({ phase: 'speaking', microphone: 'active', listening: false }).label, 'Speaking · mic off');
  assert.equal(avatarVoiceStatus({ phase: 'speaking', microphone: 'active', listening: true }).label, 'Speaking · mic on');
  assert.equal(avatarVoiceStatus({ phase: 'connecting', microphone: 'requesting' }).action, 'stop');
  assert.equal(avatarVoiceStatus({ phase: 'off', microphone: 'denied' }).action, 'settings');
});
