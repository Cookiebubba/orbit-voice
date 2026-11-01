// Native-only managed lifecycle. The existing renderer remains the one audio owner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDescriptor } from '../src/external-host.js';

const PHASES = new Set(['off', 'connecting', 'listening', 'thinking', 'speaking']);
const MICROPHONES = new Set(['off', 'requesting', 'active', 'denied', 'unknown']);
const SOURCES = new Set(['saved', 'process', 'user', 'machine']);
const FAILURES = new Set(['microphoneDenied', 'microphoneFailed', 'providerConnectionFailed']);
export function safeRendererStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((k) => !['rendererReady', 'phase', 'microphone', 'muted', 'credentialAvailable', 'failure'].includes(k))
    || typeof value.rendererReady !== 'boolean' || !PHASES.has(value.phase) || !MICROPHONES.has(value.microphone)
    || typeof value.muted !== 'boolean' || typeof value.credentialAvailable !== 'boolean'
    || value.failure != null && !FAILURES.has(value.failure)) return null;
  return { rendererReady: value.rendererReady, phase: value.phase, microphone: value.microphone, muted: value.muted, credentialAvailable: value.credentialAvailable, failure: value.failure ?? null };
}

export function createManagedRuntime({ host, identity, getSettings, getCredentials, send, showSettings, quit,
  setPreferences, now = Date.now, pollMs = 750, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const runtime = { runtimeId: identity.runtimeId || crypto.randomUUID(), pid: identity.pid, buildId: identity.buildId };
  let renderer = { rendererReady: false, phase: 'off', microphone: 'off', muted: false, credentialAvailable: false };
  let timer = null, stopped = false, running = false, leaseUntil = 0, epoch = null, intentionalStop = false, closing = null;
  const applied = new Set(), seen = new Set();
  const rendererPending = new Set();
  const startedAt = now();
  const status = () => {
    const s = getSettings(), c = getCredentials() || {};
    const openai = s.voiceEngine === 'openai';
    return { ...runtime, rendererReady: renderer.rendererReady,
      preferences: { provider: openai ? 'openai' : 'grok', model: openai ? s.openaiModel : s.model,
        voice: openai ? s.openaiVoice : s.voice, volume: Math.round(Math.max(0, Math.min(1, s.voiceVolume)) * 100), listenMode: s.listenMode },
      credentialAvailable: openai ? c.available === true : renderer.credentialAvailable,
      credentialSource: openai && SOURCES.has(c.effectiveSource) ? c.effectiveSource : !openai && renderer.credentialAvailable ? 'saved' : 'none',
      microphone: renderer.microphone, phase: renderer.phase, muted: renderer.muted, failure: renderer.failure ?? null };
  };
  function stopAudio() { send({ id: null, command: { kind: 'stop' } }); }
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const current = status();
      const cleanExit = closing && current.phase === 'off' && current.microphone === 'off' && (!closing.id || closing.applied);
      const acknowledgements = [...applied].slice(0, 16);
      const response = await host.heartbeat(current, acknowledgements, intentionalStop, !!cleanExit);
      if (stopped) return;
      if (cleanExit) { quit(); return; }
      for (const id of acknowledgements) applied.delete(id);
      if (response.schema !== 1 || typeof response.ownerEpoch !== 'string' || !Array.isArray(response.commands)
        || response.commands.length > 16 || !Number.isSafeInteger(response.leaseMs) || response.leaseMs < 1000 || response.leaseMs > 10000) throw new Error('Invalid managed heartbeat');
      if (epoch !== response.ownerEpoch) { epoch = response.ownerEpoch; applied.clear(); seen.clear(); rendererPending.clear(); }
      leaseUntil = now() + response.leaseMs;
      // The renderer also enforces this deadline, even if Electron's main thread stalls.
      send({ id: null, command: { kind: 'lease', until: leaseUntil, ownerEpoch: epoch } });
      for (const entry of response.commands) {
        if (!entry || typeof entry.id !== 'string' || entry.id.length > 128 || entry.runtimeId !== runtime.runtimeId
          || entry.ownerEpoch !== epoch || !Number.isSafeInteger(entry.remainingMs) || entry.remainingMs <= 0 || entry.remainingMs > 10000
          || !entry.command || seen.has(entry.id)) continue;
        if (seen.size >= 4096) { stopAudio(); continue; } // never evict a possibly unacknowledged action
        seen.add(entry.id); // consume before any side effect, including failure/unknown outcomes
        const command = entry.command;
        if (command.kind === 'showSettings') { showSettings(); applied.add(entry.id); }
        else if (command.kind === 'setPreferences') { await setPreferences(command.preferences); applied.add(entry.id); }
        else if (command.kind === 'quit' || command.kind === 'shutdown') {
          intentionalStop = command.kind === 'quit';
          closing = { id: entry.id, until: now() + 2500 };
          rendererPending.add(entry.id);
          send({ id: entry.id, command: { kind: 'stop' } });
        } else if (['start', 'stop', 'setMute'].includes(command.kind)) {
          rendererPending.add(entry.id);
          send({ id: entry.id, expiresAt: now() + entry.remainingMs, command });
        }
      }
      if (response.intentionalStop) stopAudio();
    } catch {
      // Silence is not readiness. Never start or retry audio when the owner is uncertain.
      if (leaseUntil && now() >= leaseUntil) stopAudio();
      if (!leaseUntil && now() - startedAt >= 15000) quit();
    } finally {
      running = false;
      if (!stopped && closing && now() >= closing.until) { stopAudio(); quit(); return; }
      if (!stopped) timer = setTimer(tick, pollMs);
    }
  }
  return {
    start() { void tick(); },
    update(value) { const safe = safeRendererStatus(value); if (safe) renderer = safe; return !!safe; },
    acknowledge(id, ok) {
      if (typeof id !== 'string' || !rendererPending.delete(id)) return false;
      if (ok === true) { applied.add(id); if (closing?.id === id) closing.applied = true; }
      return true;
    },
    quit() {
      intentionalStop = true; closing = { id: null, until: now() + 2500 }; stopAudio();
      clearTimer(timer); void tick();
    },
    stop() { stopped = true; clearTimer(timer); stopAudio(); },
    status,
  };
}

// Watch only the original trusted canonical path. Atomic replacement/absence is normal;
// every changed descriptor is fully revalidated before replacing the stable facade.
export function watchManagedDescriptor(file, host, { intervalMs = 750, read = readDescriptor } = {}) {
  const trusted = fs.realpathSync(file);
  let signature = null, stopped = false, timer = null;
  const reconcile = () => {
    if (stopped) return;
    try {
      const stat = fs.lstatSync(trusted);
      const next = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (next !== signature) { host.replaceDescriptor(read(trusted)); signature = next; }
    } catch { /* Preserve selection and uncertainty; never pair to another path. */ }
    timer = setTimeout(reconcile, intervalMs); timer.unref?.();
  };
  const parent = path.dirname(trusted);
  let watcher;
  try { watcher = fs.watch(parent, () => { signature = null; }); watcher.on('error', () => { signature = null; }); } catch {}
  reconcile();
  return () => { stopped = true; clearTimeout(timer); watcher?.close(); };
}
