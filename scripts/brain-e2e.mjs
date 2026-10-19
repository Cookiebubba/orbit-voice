// End-to-end check of the second brain through the real bridge, without xAI: a stand-in Grok
// realtime server asks ask_second_brain exactly like Grok would, the bridge runs it against the
// project of the Claude session that's open, and real Claude answers.
//
//   node scripts/brain-e2e.mjs ["question"] [--model haiku|sonnet|opus] [--think]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const question = args.find((a) => !a.startsWith('--') && !['haiku', 'sonnet', 'opus'].includes(a)) || 'In this project, how does the app decide whether a spoken reply counts as a yes before sending a prompt? One or two sentences.';
const model = args[args.indexOf('--model') + 1] && ['haiku', 'sonnet', 'opus'].includes(args[args.indexOf('--model') + 1]) ? args[args.indexOf('--model') + 1] : 'haiku';
const mode = args.includes('--think') ? 'think' : 'explore';
const FAKE_PORT = 4399;
const PORT = 4318;

// Stand-in for wss://api.x.ai/v1/realtime.
const fake = new WebSocketServer({ host: '127.0.0.1', port: FAKE_PORT });
const result = new Promise((resolve) => {
  fake.on('connection', (ws) => {
    let asked = false;
    let output = null;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'session.update' && !asked) {
        asked = true;
        const tool = m.session.tools.find((t) => t.name === 'ask_second_brain');
        console.log(`Grok got the tool: ${!!tool}; its instructions mention the second brain: ${/Second brain:/.test(m.session.instructions)}`);
        const t0 = Date.now();
        ws.send(JSON.stringify({ type: 'response.created' }));
        ws.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'ask_second_brain', arguments: JSON.stringify({ question, mode, model }) }));
        ws.send(JSON.stringify({ type: 'response.done' }));
        ws.t0 = t0;
      } else if (m.type === 'conversation.item.create' && m.item?.type === 'function_call_output' && m.item.call_id === 'call_1') {
        output = { ms: Date.now() - ws.t0, body: JSON.parse(m.item.output) };
      } else if (m.type === 'response.create' && output) {
        resolve({ ...output, continued: true });
      }
    });
  });
});

process.env.XAI_REALTIME_URL = `ws://127.0.0.1:${FAKE_PORT}`;
process.env.XAI_API_KEY = 'xai-stand-in-not-used';
const { startServer, authUrl } = await import('../src/server.js');
await startServer({ port: PORT, configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-brain-e2e-')) });
const auth = await fetch(authUrl('main'), { redirect: 'manual' });
const cookie = auth.headers.get('set-cookie').split(';')[0];
const page = new WebSocket(`ws://127.0.0.1:${PORT}/voice`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie } });
page.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'bridge.tool' && m.name === 'ask_second_brain') console.log(`Bridge: running ask_second_brain (${mode}, ${model})…`);
});

const r = await Promise.race([result, new Promise((_, rej) => setTimeout(() => rej(new Error('no answer within 5 minutes')), 330_000))]);
console.log(`\nAnswer back to Grok after ${(r.ms / 1000).toFixed(1)} s (then the bridge asked Grok to continue: ${r.continued}):`);
console.log(JSON.stringify(r.body, null, 2));
page.close();
fake.close();
setTimeout(() => process.exit(r.body.answer ? 0 : 1), 300);
