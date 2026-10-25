#!/usr/bin/env node
// A soak run: many whole conversations in a row on one app, watching its memory, so a leak in a call's
// path (the voice socket, audio, on-device speech, the overlays) shows before users find it.
//
//   node parity/tools/soak.mjs [--app swift|electron|both] [--cycles 40] [--max-growth-mb 1]
//
// Each cycle, with Claude voice (on-device speech, the scripted Claude Code), the fake microphone and
// muted output, exactly as the voice parity cases: the hotkey starts a call, a spoken question goes in
// ("What is Claude asking for?"), Orbit answers out loud, then the call is hung up. The app's process
// tree memory (parity/lib/procs.mjs) is sampled after every cycle. The verdict is the slope of a
// straight line through the samples after the first five (warm-up: caches, models, pages); a slope
// above --max-growth-mb per cycle fails. Results: parity/out/soak.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, until } from '../lib/apps.mjs';
import { rssMb, tree, kinds, webkitPids } from '../lib/procs.mjs';
import { PORTS, paths, prepare } from '../run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const opt = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const APPS = opt('app', 'both') === 'both' ? ['swift', 'electron'] : [opt('app')];
const CYCLES = Number(opt('cycles', 40));
const WARMUP = 5;
const MAX_SLOPE = Number(opt('max-growth-mb', 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASE = {
  id: 'soak',
  fixtures: { fakeDesktop: true, claudeVoice: { rules: { rules: [], fallback: 'Okay, nothing is waiting.' } } },
};

/** Least-squares slope of y over x. */
function slope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) (num += (xs[i] - mx) * (ys[i] - my)), (den += (xs[i] - mx) ** 2);
  return den ? num / den : 0;
}

async function soak(which) {
  const prep = await prepare(CASE, which);
  const webkitBefore = webkitPids();
  const app = await startApp(which, { paths, profileDir: prep.dirs.profile, logDir: prep.dirs.logs, bridgePort: PORTS[which].bridge, driverPort: PORTS[which].driver, env: prep.env });
  const d = app.driver;
  const state = async () => (await d.state()).body;
  const phase = async (want, ms) => {
    const s = await until(async () => {
      const v = (await state()).voice;
      return want.includes(v.phase) ? v : null;
    }, ms, 150);
    if (!s) throw new Error(`the voice never reached ${want.join(' or ')}`);
    return s;
  };
  const clip = path.join(paths.audio, 'asking.wav');
  if (!fs.existsSync(clip)) throw new Error(`no ${clip} (npm run parity:audio)`);
  const samples = [];
  const failures = [];
  const t0 = Date.now();
  try {
    for (let i = 1; i <= CYCLES; i++) {
      try {
        await d.act('voice.hotkey', {});
        const before = (await phase(['listening'], 25_000)).playedMs;
        await d.act('mic.play', { wav: clip });
        // Orbit hears it, answers out loud (muted), and is listening again.
        await until(async () => {
          const v = (await state()).voice;
          return v.phase === 'listening' && v.playedMs > before ? v : null;
        }, 45_000, 200);
        await d.act('voice.hangup', {});
        await phase(['off'], 10_000);
      } catch (e) {
        failures.push({ cycle: i, error: String(e.message).slice(0, 200) });
        try {
          await d.act('voice.hangup', {});
        } catch {}
      }
      await sleep(1000);
      const t = tree(app.pid, webkitBefore);
      samples.push({ cycle: i, rssMb: Math.round(rssMb(t) * 10) / 10, processes: t.length, byKind: kinds(t), at: Date.now() - t0 });
      process.stdout.write(`${which} cycle ${i}/${CYCLES}: ${samples.at(-1).rssMb} MB${failures.at(-1)?.cycle === i ? ' (failed)' : ''}\n`);
    }
    const warm = samples.filter((s) => s.cycle > WARMUP);
    const perCycle = warm.length > 2 ? slope(warm.map((s) => s.cycle), warm.map((s) => s.rssMb)) : 0;
    const byKind = kinds(tree(app.pid, webkitBefore));
    // Which process grows: the same slope per kind of process.
    const names = [...new Set(warm.flatMap((s) => Object.keys(s.byKind)))];
    const growthByKind = Object.fromEntries(names.map((k) => [k, Math.round(slope(warm.map((s) => s.cycle), warm.map((s) => s.byKind[k] || 0)) * 100) / 100]));
    return {
      cycles: CYCLES,
      failed: failures.length,
      failures: failures.slice(0, 10),
      startMb: samples[WARMUP - 1]?.rssMb ?? null,
      endMb: samples.at(-1)?.rssMb ?? null,
      growthMbPerCycle: Math.round(perCycle * 100) / 100,
      growthByKind,
      pass: failures.length === 0 && perCycle <= MAX_SLOPE,
      byKind,
      samples,
    };
  } finally {
    await app.stop();
    await prep.teardown();
    fs.rmSync(prep.dirs.run, { recursive: true, force: true });
  }
}

const result = { at: new Date().toISOString(), cycles: CYCLES, maxGrowthMbPerCycle: MAX_SLOPE };
for (const which of APPS) result[which] = await soak(which);
fs.mkdirSync(path.join(REPO, 'parity', 'out'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'parity', 'out', 'soak.json'), JSON.stringify(result, null, 2));
for (const which of APPS) {
  const r = result[which];
  console.log(`${which}: ${r.pass ? 'PASS' : 'FAIL'}: ${r.cycles} calls, ${r.failed} failed, memory ${r.startMb} -> ${r.endMb} MB after warm-up (${r.growthMbPerCycle} MB per call: ${JSON.stringify(r.growthByKind)}) ${JSON.stringify(r.byKind)}`);
}
process.exit(APPS.every((w) => result[w].pass) ? 0 : 1);
