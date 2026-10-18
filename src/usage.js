// Counts how long you're connected to Grok (that's what xAI bills for), per day.
// Stored as { "2026-10-18": seconds, ... } in usage.json next to settings.json.

import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir, getSetting } from './config.js';

const file = () => path.join(getConfigDir(), 'usage.json');
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

function load() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function add(seconds) {
  if (seconds <= 0) return;
  const data = load();
  data[today()] = Math.round((data[today()] || 0) + seconds);
  // Keep about a year.
  const keys = Object.keys(data).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete data[k];
  fs.writeFileSync(file(), JSON.stringify(data));
}

/** Call when a Grok connection opens; call the returned function when it closes. */
export function startMeter() {
  let last = Date.now();
  const flush = () => {
    const now = Date.now();
    add((now - last) / 1000);
    last = now;
  };
  const timer = setInterval(flush, 30_000); // so a crash loses at most 30 s
  return () => {
    clearInterval(timer);
    flush();
  };
}

export function usageSummary() {
  const data = load();
  const t = today();
  const month = t.slice(0, 7);
  const secs = (pred) => Object.entries(data).filter(([d]) => pred(d)).reduce((a, [, s]) => a + s, 0);
  const rate = getSetting('costPerMinute');
  const mk = (s) => ({ minutes: Math.round((s / 60) * 10) / 10, cost: Math.round((s / 60) * rate * 100) / 100 });
  return { today: mk(secs((d) => d === t)), month: mk(secs((d) => d.startsWith(month))), costPerMinute: rate };
}
