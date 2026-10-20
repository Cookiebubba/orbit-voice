// Settings and the xAI key.
//
// Where things live:
//   - Desktop app: Electron calls initConfig() with its per-user data folder
//     (%APPDATA%\Orbit) and a secret store that encrypts the key with Windows DPAPI.
//   - Dev / browser mode (`npm run web`): the project folder, key in a plain .env file.
// settings.json only ever holds non-secret preferences.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaudeFile } from './brain.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = Object.freeze({
  voice: 'eve',
  speed: 1,
  wakeHotkey: 'Control+Alt+G',
  listenMode: 'always', // 'always' = until you say "go to sleep"; 'tap' = one question per hotkey press
  halfDuplex: false, // true = ignore the mic while Grok is talking (for speakers without headphones)
  wakeWord: false, // "Hey Grok" via the offline Vosk model, only while Grok is off or asleep
  announce: 'speak', // when Claude finishes: 'speak' | 'chime' | 'off'
  // With announce 'speak': while Grok is asleep, connect just long enough to say it, then listen
  // ~3 s for a reply. Off by default: each wake bills a few seconds of xAI time.
  announceWake: false,
  // With announce 'speak': wake Grok when something the user asked for is ready (a prompt Orbit
  // sent finished in Claude, or a second-brain answer that came back after hanging up). Only their
  // own results, at most a few wakes an hour; a question still running at hang-up keeps going.
  wakeOnResults: true,
  costPerMinute: 0.08, // USD, xAI's published voice-agent rate at the time of writing
  model: 'grok-voice-latest',
  orbPosition: null, // [x, y] of the floating orb
  autoUpdate: true, // check GitHub Releases at launch and every 6 h, download, install on quit
  orbStick: false, // "Stick to Claude Code": the orb rides on the Claude window
  orbPulse: false, // "Pulse with your voice": the orb grows very slightly as you speak
  orbPulseGrok: false, // "Pulse with Grok's voice": the same while Grok speaks
  orbPulseAmount: 0.05, // how much it grows at full volume: 0.01–0.1 (1–10%)
  orbStickAnchor: null, // { corner: 'tl'|'tr'|'bl'|'br', dx, dy } in DIPs from that corner of the Claude window
  // Second brain: Grok can hand hard questions to Claude through the user's Claude Code.
  brainEnabled: true,
  brainModel: 'auto', // 'auto' = Grok picks Haiku, Sonnet or Opus per question; or always one of them
  brainExplore: true, // may read (never change) the project of the open Claude session
  brainConnection: 'claude-code', // 'claude-code' = the user's Claude login; 'api-key' = an Anthropic API key
  brainClaudePath: '', // '' = find Claude Code automatically
});

export const LIMITS = Object.freeze({ minSpeed: 0.7, maxSpeed: 1.5 });

const ENV_OVERRIDES = {
  GROK_VOICE: 'voice',
  GROK_VOICE_SPEED: 'speed',
  WAKE_HOTKEY: 'wakeHotkey',
  GROK_VOICE_MODEL: 'model',
};

let configDir = PROJECT_ROOT;
let settings = { ...DEFAULTS };
let secretStore = null;
let brainSecretStore = null;
const listeners = new Set();

/** Plain-text .env store, used outside the desktop app. */
function envSecretStore(dir, name = 'XAI_API_KEY') {
  const file = path.join(dir, '.env');
  return {
    kind: 'env-file',
    get: () => readDotEnv(file)[name] || '',
    set: (key) => writeDotEnvValue(file, name, key),
  };
}

export function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function writeDotEnvValue(file, name, value) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.trim().startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}

// Only plain values get converted: an object like {"toString": 1} would make Number()/String() throw.
function coerce(key, value) {
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return value === true || value === 'true';
  if (typeof def === 'number') return typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : undefined;
  if (typeof def === 'string') return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  return value; // object settings (positions, anchors, rules) are checked by their own case below
}

/** Keep only known keys with sane values. */
function sanitize(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!Object.hasOwn(DEFAULTS, k)) continue;
    const val = coerce(k, v);
    if (val === undefined) continue;
    switch (k) {
      case 'voice':
        if (/^[a-z0-9_-]{1,40}$/i.test(String(val))) out.voice = String(val).toLowerCase();
        break;
      case 'speed':
        if (Number.isFinite(val)) out.speed = Math.min(LIMITS.maxSpeed, Math.max(LIMITS.minSpeed, Math.round(val * 100) / 100));
        break;
      case 'listenMode':
        if (val === 'always' || val === 'tap') out.listenMode = val;
        break;
      case 'announce':
        if (['speak', 'chime', 'off'].includes(val)) out.announce = val;
        break;
      case 'costPerMinute':
        if (Number.isFinite(val) && val >= 0 && val < 10) out.costPerMinute = Math.round(val * 1000) / 1000;
        break;
      case 'wakeHotkey':
      case 'model':
        if (typeof val === 'string' && val.length > 0 && val.length < 60 && /^[\w+.-]+$/.test(val)) out[k] = val;
        break;
      case 'brainModel':
        if (['auto', 'haiku', 'sonnet', 'opus'].includes(val)) out.brainModel = val;
        break;
      case 'brainConnection':
        if (val === 'claude-code' || val === 'api-key') out.brainConnection = val;
        break;
      case 'brainClaudePath':
        // Only ever a local absolute path (no network share) to claude.exe on Windows, claude
        // elsewhere (see isClaudeFile in brain.js), or '' for automatic.
        if (val === '' || (typeof val === 'string' && val.length < 400 && path.isAbsolute(val) && !/^[\\/]{2}/.test(val) && ![...val].some((c) => c.charCodeAt(0) < 32 || '"<>|?*'.includes(c)) && isClaudeFile(val))) out.brainClaudePath = val;
        break;
      case 'orbPulseAmount':
        if (Number.isFinite(val)) out.orbPulseAmount = Math.min(0.1, Math.max(0.01, Math.round(val * 1000) / 1000));
        break;
      case 'orbStickAnchor':
        if (val === null || (val && ['tl', 'tr', 'bl', 'br'].includes(val.corner) && [val.dx, val.dy].every((n) => Number.isFinite(n) && n >= 0 && n <= 10000))) {
          out.orbStickAnchor = val && { corner: val.corner, dx: Math.round(val.dx), dy: Math.round(val.dy) };
        }
        break;
      case 'orbPosition':
        if (val === null || (Array.isArray(val) && val.length === 2 && val.every(Number.isFinite))) out.orbPosition = val && val.map(Math.round);
        break;
      default:
        if (typeof val === typeof DEFAULTS[k]) out[k] = val;
    }
  }
  return out;
}

/**
 * Load settings. Call once at startup (the desktop app passes its own folder and key store).
 * Order: defaults → .env overrides in the project folder → settings.json in the config folder.
 */
export function initConfig({ dir, secrets, brainSecrets } = {}) {
  configDir = dir || PROJECT_ROOT;
  fs.mkdirSync(configDir, { recursive: true });
  secretStore = secrets || envSecretStore(configDir);
  brainSecretStore = brainSecrets || envSecretStore(configDir, 'ANTHROPIC_API_KEY');

  const env = { ...readDotEnv(path.join(PROJECT_ROOT, '.env')), ...process.env };
  const fromEnv = {};
  for (const [envName, key] of Object.entries(ENV_OVERRIDES)) if (env[envName] !== undefined) fromEnv[key] = env[envName];

  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  } catch {}
  settings = { ...DEFAULTS, ...sanitize(fromEnv), ...sanitize(fromFile) };

  // First run of the desktop app on a machine that used the dev version: bring the key over.
  if (!secretStore.get() && env.XAI_API_KEY) secretStore.set(env.XAI_API_KEY.trim());
  return settings;
}

export const getSettings = () => ({ ...settings });
export const getSetting = (k) => settings[k];

/** Merge and save. Returns the keys that actually changed. */
export function updateSettings(patch) {
  const clean = sanitize(patch);
  const changed = Object.keys(clean).filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(settings[k]));
  if (!changed.length) return [];
  settings = { ...settings, ...clean };
  const toSave = Object.fromEntries(Object.entries(settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(toSave, null, 2));
  for (const fn of listeners) fn(changed, getSettings());
  return changed;
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getApiKey = () => (secretStore ? secretStore.get() : '') || '';
export const setApiKey = (key) => secretStore.set(key);
export const keyStorageKind = () => secretStore?.kind || 'none';
/** The optional Anthropic API key for the second brain (stored like the xAI key). */
export const getBrainKey = () => (brainSecretStore ? brainSecretStore.get() : '') || '';
export const setBrainKey = (key) => brainSecretStore.set(key);
export const getConfigDir = () => configDir;
