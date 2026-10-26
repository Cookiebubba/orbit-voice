#!/usr/bin/env node
// Size, start-up time, and idle CPU and memory of the two builds, the same way for both:
//   node parity/tools/measure.mjs [--runs 3] [--idle 30]
//
// - Start-up: from `open` to the app's driver saying ready (bridge up, main window and page loaded).
// - Idle: after a 15 s settle with the launcher shown and nothing happening, the CPU time the app's
//   processes use over --idle seconds (from ps cputime deltas, so no sampling noise) and their
//   resident memory at the end. "The app's processes": the app and its children (Electron's helpers;
//   Orbit Native's Node sidecar and macOS helper) plus the WebKit processes that appeared with it
//   (WebKit runs pages in XPC services that aren't the app's children; any other WebKit app starting
//   during a run would be counted too, so runs are repeated and the median kept).
// - Size: the .app bundles on disk (du).
// Each run uses a throwaway profile, a fake microphone and muted output, like the parity runs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../lib/apps.mjs';
import { kinds, tree, webkitPids } from '../lib/procs.mjs';
import { silentWav } from '../run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const opt = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const RUNS = Number(opt('runs', 3));
const IDLE_S = Number(opt('idle', 30));
const paths = { repo: REPO, swiftApp: path.join(REPO, 'mac-swift', 'dist', 'Orbit Native.app'), electronRoot: REPO };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const du = (p) => (fs.existsSync(p) ? Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0]) * 1024 : null);

async function measure(which) {
  const out = [];
  for (let i = 0; i < RUNS; i++) {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-measure-${which}-`));
    const profile = path.join(run, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    const silence = path.join(run, 'silence.wav');
    fs.writeFileSync(silence, silentWav(0.2));
    const webkitBefore = webkitPids();
    const t0 = Date.now();
    const app = await startApp(which, {
      paths,
      profileDir: profile,
      logDir: run,
      bridgePort: which === 'swift' ? 4521 : 4541,
      driverPort: which === 'swift' ? 4522 : 4542,
      env: { ORBIT_FAKE_MIC: silence, ORBIT_FAKE_PERMS: JSON.stringify({ mic: 'granted', ax: true, screen: true }) },
    });
    const startupMs = Date.now() - t0;
    await sleep(15_000);
    const a = tree(app.pid, webkitBefore);
    const cpu0 = new Map(a.map((p) => [p.pid, p.cpu]));
    await sleep(IDLE_S * 1000);
    const b = tree(app.pid, webkitBefore);
    const cpuS = b.reduce((s, p) => s + (p.cpu - (cpu0.get(p.pid) ?? p.cpu)), 0);
    const rssMb = b.reduce((s, p) => s + p.rssKb, 0) / 1024;
    out.push({ startupMs, idleCpuPct: (100 * cpuS) / IDLE_S, rssMb, processes: b.length, byKind: kinds(b) });
    await app.stop();
    fs.rmSync(run, { recursive: true, force: true });
    await sleep(2000);
  }
  return {
    startupMs: median(out.map((r) => r.startupMs)),
    idleCpuPct: Math.round(median(out.map((r) => r.idleCpuPct)) * 100) / 100,
    rssMb: Math.round(median(out.map((r) => r.rssMb))),
    processes: median(out.map((r) => r.processes)),
    runs: out,
  };
}

const result = {
  at: new Date().toISOString(),
  size: {
    swiftApp: du(paths.swiftApp),
  },
  swift: await measure('swift'),
};
fs.mkdirSync(path.join(REPO, 'parity', 'out'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'parity', 'out', 'measure.json'), JSON.stringify(result, null, 2));
const mb = (b) => (b == null ? '-' : `${Math.round(b / 1048576)} MB`);
console.log(`size: Orbit Native ${mb(result.size.swiftApp)}`);
for (const w of ['swift']) {
  const r = result[w];
  console.log(`${w}: start-up ${r.startupMs} ms, idle CPU ${r.idleCpuPct}%, memory ${r.rssMb} MB in ${r.processes} processes ${JSON.stringify(r.runs.at(-1).byKind)}`);
}
