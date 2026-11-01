import { EventEmitter } from 'node:events';
const state = () => globalThis.__managedAcceptance;
export function credentials() {
  const value = { key: 'sk-managed-fixture-000000000000000000000000', source: 'process' };
  return { get: () => ({ ...value }), status: () => ({ available: true, source: 'process', pending: false, error: null }),
    async refresh() { return this.status(); } };
}
export function realtimeFactory() {
  const s = state();
  s.providerStarts++;
  class Provider extends EventEmitter {
    readyState = 1;
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'session.update') s.tools = (message.session?.tools || []).map((t) => t.name);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3; s.providerCloses++;
      this.emit('close', 1000, Buffer.from('fixture'));
    }
  }
  const provider = new Provider();
  setImmediate(() => provider.emit('open'));
  return provider;
}
