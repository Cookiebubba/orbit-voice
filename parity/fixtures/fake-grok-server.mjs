// The stand-in Grok (test/e2e/fake-grok.mjs) as its own process for the parity runner:
//   node parity/fixtures/fake-grok-server.mjs <port> <seed> <recordDir>
// Writes what each connection did (counts, tool calls, close codes; no audio) to
// <recordDir>/fake-grok.json every 200 ms, for the runner's `fake` step.
import fs from 'node:fs';
import path from 'node:path';
import { createFakeGrok } from '../../test/e2e/fake-grok.mjs';
import { makeGen } from '../../test/fuzz/gen.mjs';

const [port, seed, recordDir] = process.argv.slice(2);
const g = createFakeGrok({ g: makeGen(Number(seed) || 1), port: Number(port) });
await g.ready;
console.log('ready');
const file = recordDir ? path.join(recordDir, 'fake-grok.json') : '';
const snapshot = () => ({
  conns: g.conns.map((c) => ({
    id: c.id,
    configured: c.configured,
    tools: c.tools || [],
    appends: c.appends,
    responses: c.responses.length,
    audioChunks: c.responses.reduce((n, r) => n + r.audioChunks, 0),
    toolCalls: c.toolCalls.map((t) => ({ name: t.name, result: t.result ?? null })),
    typed: c.utterances.filter((u) => u.typed).length,
    open: c.ws.readyState === 1,
    closeCode: c.closeCode,
    auth: c.auth ? 'present' : 'missing',
  })),
});
if (file) setInterval(() => {
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(snapshot()));
    fs.renameSync(file + '.tmp', file);
  } catch {}
}, 200);
