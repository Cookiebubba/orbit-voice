// Minimal stdio MCP server the Supervisor injects into every sub-agent session
// (ACP session/new `mcpServers`). It does nothing itself: the Supervisor reads
// the report_progress call's arguments from the ACP tool_call stream, so
// progress works the same for any agent that can call MCP tools.

import readline from 'node:readline';

const TOOLS = [{
  name: 'report_progress',
  description: 'Report task progress to the user\'s dashboard. Call it after finishing each step.',
  inputSchema: {
    type: 'object',
    properties: {
      done: { type: 'integer', description: 'Steps finished so far' },
      total: { type: 'integer', description: 'Total steps planned' },
      step: { type: 'string', description: 'Short label for the step you are starting next, or "finished"' },
    },
    required: ['done', 'total', 'step'],
  },
}];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notifications
  switch (req.method) {
    case 'initialize':
      return send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'orbit', version: '0.0.1' } } });
    case 'tools/list':
      return send({ id: req.id, result: { tools: TOOLS } });
    case 'tools/call':
      return send({ id: req.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    case 'ping':
      return send({ id: req.id, result: {} });
    default:
      return send({ id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
  }
});
