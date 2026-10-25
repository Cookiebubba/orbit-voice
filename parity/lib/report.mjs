// The parity matrix: parity/out/matrix.json (every case, each build's status) and matrix.md (a
// summary per area, then one row per case).
import fs from 'node:fs';
import path from 'node:path';

const ICON = { pass: 'pass', fail: 'FAIL', error: 'ERROR', unsupported: 'n/a' };

export function summarize(apps, results) {
  const summary = {};
  for (const a of apps) {
    summary[a] = {};
    for (const r of results) {
      const s = (summary[a][r.area] ??= { pass: 0, total: 0 });
      s.total++;
      if (r[a]?.status === 'pass') s.pass++;
    }
    const all = Object.values(summary[a]).reduce((t, s) => ({ pass: t.pass + s.pass, total: t.total + s.total }), { pass: 0, total: 0 });
    summary[a].all = all;
  }
  return summary;
}

export function writeMatrix({ out, apps, results }) {
  const summary = summarize(apps, results);
  const doc = { at: new Date().toISOString(), apps, cases: results, summary };
  const json = path.join(out, 'matrix.json');
  fs.writeFileSync(json, JSON.stringify(doc, null, 2));
  const areas = [...new Set(results.map((r) => r.area))];
  const lines = ['# Orbit parity matrix', '', `${doc.at}`, '', `| Area | ${apps.join(' | ')} |`, `| --- | ${apps.map(() => '---').join(' | ')} |`];
  for (const area of [...areas, 'all']) lines.push(`| ${area} | ${apps.map((a) => `${summary[a][area]?.pass ?? 0}/${summary[a][area]?.total ?? 0}`).join(' | ')} |`);
  lines.push('', '## Cases', '', `| Case | ${apps.join(' | ')} |`, `| --- | ${apps.map(() => '---').join(' | ')} |`);
  for (const r of results) lines.push(`| ${r.id} | ${apps.map((a) => ICON[r[a]?.status] || '-').join(' | ')} |`);
  const fails = results.flatMap((r) => apps.filter((a) => r[a] && r[a].status !== 'pass').map((a) => `- **${r.id}** (${a}, ${r[a].status}): ${String(r[a].error || '').replace(/\|/g, '/')}`));
  if (fails.length) lines.push('', '## Not passing', '', ...fails);
  const md = path.join(out, 'matrix.md');
  fs.writeFileSync(md, lines.join('\n') + '\n');
  return { json, md: lines.join('\n') };
}
