// Runs a stand-in desktop driver module (ORBIT_FAKE_DESKTOP, e.g. parity/fixtures/fake-desktop.mjs)
// for Orbit Native's engine in a test build: JSON lines on stdin ({ id, op: "run", mode, args }), one
// answer per line on stdout ({ id, ok: true, result }). The Electron build loads the same module
// in-process; this is the same stand-in, reached from Swift.
//   node parity/fixtures/fake-desktop-host.mjs <module.mjs>
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const fake = mod.default || mod;
const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.op !== 'run') return write({ id: msg?.id, ok: false, error: 'bad_request' });
  try {
    write({ id: msg.id, ok: true, result: await fake.run(String(msg.mode), Array.isArray(msg.args) ? msg.args.map(String) : []) });
  } catch (e) {
    write({ id: msg.id, ok: false, error: String(e?.message || e).slice(0, 200) });
  }
});
process.stdin.on('end', () => process.exit(0));
