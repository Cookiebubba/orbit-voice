// Error and event log: kept in memory (so Grok can read recent problems with a tool) and in
// <config dir>/logs/orbit.log (so you can attach it to a bug report).
//
// Never logs prompt text, transcript content or keys: callers pass short descriptions, and
// anything that looks like a secret is scrubbed before it's stored.

import fs from 'node:fs';
import path from 'node:path';

const MAX_MEMORY = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const entries = [];
let logDir = null;

export function initLog(dir) {
  logDir = path.join(dir, 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    logDir = null;
  }
}

export const getLogDir = () => logDir;

export function scrub(text) {
  return String(text ?? '')
    .replace(/xai-[A-Za-z0-9_-]{8,}/g, 'xai-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/(api[_-]?key|token|secret|password)(["'\s:=]+)[^\s"',}]+/gi, '$1$2***')
    .slice(0, 1000);
}

function write(level, source, message, detail) {
  const entry = { at: new Date().toISOString(), level, source, message: scrub(message) };
  if (detail !== undefined && detail !== null && detail !== '') entry.detail = scrub(typeof detail === 'string' ? detail : JSON.stringify(detail));
  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.shift();
  if (level === 'error') console.error(`[${source}] ${entry.message}${entry.detail ? ` (${entry.detail})` : ''}`);
  if (!logDir) return entry;
  try {
    const file = path.join(logDir, 'orbit.log');
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, path.join(logDir, 'orbit.1.log'));
    } catch {}
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {}
  return entry;
}

export const logError = (source, message, detail) => write('error', source, message, detail);
export const logWarn = (source, message, detail) => write('warn', source, message, detail);
export const logInfo = (source, message, detail) => write('info', source, message, detail);

/** Recent entries, newest last. */
export function recentLog({ limit = 20, minLevel = 'warn', sinceMs = 24 * 60 * 60 * 1000 } = {}) {
  const rank = { info: 0, warn: 1, error: 2 };
  const since = Date.now() - sinceMs;
  return entries.filter((e) => rank[e.level] >= rank[minLevel] && Date.parse(e.at) >= since).slice(-limit);
}
