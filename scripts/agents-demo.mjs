// Dev demo for the Agents window: starts the bridge on a spare port with temp config and runs
// folders, then drives scripted ACP agents (test/fixtures/fake-acp-agent.js) through a mix of
// states. No tokens are spent. Prints a sign-in link that opens the Agents page in a browser.
//
//   node scripts/agents-demo.mjs [--port 4318]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authUrl, startServer } from '../src/server.js';
import { Supervisor } from '../src/agents/supervisor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-acp-agent.js');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4318;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agents-demo-'));
const runsDir = path.join(base, 'runs');

await startServer({ port, configDir: path.join(base, 'config'), agentsRuns: runsDir });
console.log(`\n  Agents demo. Open:\n  ${authUrl('agents')}\n`);

const sup = Supervisor.create({ runsDir, goal: 'Harden the sleep and hang-up flow', agentCommand: { command: process.execPath, args: [FAKE] }, maxConcurrent: 5 });
const spawn = (name, role, task, extra = {}) => sup.spawn({ name, role, task, writes: role.startsWith('writer'), ...extra });

const review = spawn('review', 'reader', 'Security review of the new /api/agents endpoints [fake steps=4 stepMs=900 costPerStep=0.08]');
const tests = spawn('tests', 'writer', 'Unit tests for hangUpWhenQuiet and the tap-mode draft hold [fake steps=7 stepMs=4000 costPerStep=0.06]');
const docs = spawn('docs', 'writer', 'Update README and CHANGELOG for "go to sleep hangs up" [fake steps=4 stepMs=1500 write=ask costPerStep=0.04]');
const refactor = spawn('refactor', 'writer', 'Split server.js routes into modules, no behaviour change [fake steps=9 stepMs=2500 costPerStep=0.07]');
const flaky = spawn('perf', 'reader', 'Profile the voice relay under load [fake steps=5 stepMs=1200 crashAt=3 costPerStep=0.05]');
spawn('changelog', 'writer', 'Draft release notes for 1.2.0 [fake steps=3 stepMs=2000 costPerStep=0.03]');
spawn('budget', 'writer', 'Regenerate the hero image variants [fake steps=8 stepMs=1500 costPerStep=0.2]', { budget: { costUsd: 0.5 } });

// Approve docs' first write after a few seconds, leave its second one waiting on the card.
let approvals = 0;
sup.on('event', (e) => {
  if (e.type === 'agent_needs' && e.id === docs && approvals++ === 0) setTimeout(() => sup.answer(docs, true), 4000);
});
// Pause refactor after its second step, as if you clicked "Pause after this step".
const parkRefactor = () => {
  if (sup.card(refactor).progress.done >= 2) { sup.off('event', parkRefactor); sup.pause(refactor, { when: 'step' }); }
};
sup.on('event', parkRefactor);

void review; void tests; void flaky;
process.on('SIGINT', async () => { await sup.shutdown(); process.exit(0); });
