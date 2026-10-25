// An app's processes on macOS, for the measurement tools (tools/measure.mjs, tools/soak.mjs): the app
// and its children (Electron's helpers; Orbit Native's Node sidecar and macOS helper) plus the WebKit
// processes that appeared with it (WebKit runs pages in XPC services that aren't the app's children).
import { execFileSync } from 'node:child_process';

export function ps() {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 })
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/);
      return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], cpu: cpuSeconds(m[4]), cmd: m[5] };
    })
    .filter(Boolean);
}

export function cpuSeconds(t) {
  return t.split(':').reduce((s, x) => s * 60 + Number(x), 0);
}

export const isWebKit = (p) => /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(p.cmd);

/** The WebKit processes running now (taken before an app starts, so its own can be told apart). */
export const webkitPids = () => new Set(ps().filter(isWebKit).map((p) => p.pid));

/** The app's process tree plus WebKit processes not in `webkitBefore`. */
export function tree(rootPid, webkitBefore = new Set()) {
  const all = ps();
  const ids = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (!ids.has(p.pid) && ids.has(p.ppid)) (ids.add(p.pid), (grew = true));
  }
  for (const p of all) if (isWebKit(p) && !webkitBefore.has(p.pid)) ids.add(p.pid);
  return all.filter((p) => ids.has(p.pid));
}

/** What each kind of process holds, in MB. */
export function kinds(list) {
  const k = {};
  for (const p of list) {
    const name = /node\/bin\/node/.test(p.cmd) ? 'node sidecar' : /orbit-helper/.test(p.cmd) ? 'orbit-helper' : isWebKit(p) ? 'WebKit' : /Helper/.test(p.cmd) ? 'Electron helper' : /OrbitNative|Electron\.app\/Contents\/MacOS\/Electron$|Electron .*integ$/.test(p.cmd) ? 'app' : 'other';
    k[name] = Math.round(((k[name] || 0) + p.rssKb / 1024) * 10) / 10;
  }
  return k;
}

export const rssMb = (list) => list.reduce((s, p) => s + p.rssKb, 0) / 1024;
