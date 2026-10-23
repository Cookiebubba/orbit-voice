// A stand-in for Claude Code as a background helper (test/helper-win.test.js): started by the real
// engine (src/engines/claude-code.js) with the real arguments, it reads its task from stdin
// (stream-json), finds orbit-hands in --mcp-config, and works through it over HTTP the way a
// helper would: initialize, list the tools, read the window, type the message, press Send (held),
// wait for the user's answer, then report on stdout (stream-json), and exit. Nothing else.
import readline from 'node:readline';

const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const mcp = JSON.parse(at('--mcp-config')).mcpServers.orbit;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let id = 0;
async function rpc(method, params) {
  const r = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).result;
}
const tool = async (name, a = {}) => {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__orbit__${name}`, input: a }] } });
  const res = await rpc('tools/call', { name, arguments: a });
  return JSON.parse(res.content[0].text);
};

const rl = readline.createInterface({ input: process.stdin });
const first = await new Promise((r) => rl.once('line', r));
const task = JSON.parse(first).message.content[0].text;
out({ type: 'system', subtype: 'init' });
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-helper', version: '1' } });
  if (init.serverInfo.name !== 'orbit-hands') throw new Error('not orbit-hands');
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
  const read = await tool('read');
  const message = /"(.+)"/.exec(task)?.[1] || 'hello';
  const typed = await tool('act', { control: 'Message', action: 'set_text', text: message });
  const held = await tool('act', { control: 'Send', action: 'press' });
  let answer = { state: 'still_waiting' };
  while (held.held && answer.state === 'still_waiting') answer = await tool('wait_for_approval', { approval_id: held.approval_id });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: `Typed it${answer.state === 'approved' ? ' and sent it' : ', but the user said no to sending'}. (tools: ${tools.length}, read: ${read.ok === false ? 'no' : 'yes'}, typed: ${typed.ok})`, total_cost_usd: 0 });
} catch (e) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `failed: ${e.message}` });
}
rl.close();
