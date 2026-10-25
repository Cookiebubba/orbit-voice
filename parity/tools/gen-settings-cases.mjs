#!/usr/bin/env node
// Writes parity/cases/settings-roundtrip.json: for every setting the Settings screen shows, a round trip each
// way (the app's own Settings → the bridge; the bridge → the app's Settings, live), plus the
// shell-owned ones (hotkey, open at login). Regenerate after adding a setting:
//   node parity/tools/gen-settings-cases.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// [value set through the app's Settings, value then set through the bridge]
const VALUES = {
  voice: ['ara', 'rex'], speed: [1.2, 0.8], voiceVolume: [0.4, 0.9], listenMode: ['tap', 'always'], halfDuplex: [true, false],
  wakeWord: [true, false], announce: ['chime', 'off'], announceWake: [true, false], wakeOnResults: [false, true],
  costPerMinute: [0.1, 0.05], autoUpdate: [false, true], orbStick: [true, false], orbPulse: [true, false], orbPulseGrok: [true, false],
  orbPulseAmount: [0.08, 0.02], brainEnabled: [false, true], brainModel: ['opus', 'haiku'], brainExplore: [false, true],
  brainConnection: ['api-key', 'claude-code'], brainClaudePath: ['/usr/local/bin/claude', ''], webSearch: [false, true],
  voiceEngine: ['claude', 'grok'], claudeVoice: [3, 5], claudeVoiceModel: ['sonnet', 'opus'], claudeVoiceEffort: ['medium', 'high'],
  claudeVoiceStt: ['parakeet-110m', 'moonshine'], avatar: ['qubit', 'none'], buddySize: [3, 1], avatarClickTalk: [false, true],
  avatarThrow: [false, true], avatarThrowSound: [false, true], showOrb: [false, true], anywhere: [false, true],
  anywhereVision: [true, false], anywhereCdp: [true, false], anywhereMouse: [false, true],
};
const NOT_IN_SETTINGS = new Set(['wakeHotkey', 'model', 'orbPosition', 'orbStickAnchor', 'anywhereMouseLeadMs', 'helperEngine', 'anywhereUnderOrbit']);
const missing = Object.keys(DEFAULTS).filter((k) => !NOT_IN_SETTINGS.has(k) && !VALUES[k]);
if (missing.length) throw new Error(`no test values for: ${missing.join(', ')}`);

const cases = [];
for (const [key, [a, b]] of Object.entries(VALUES)) {
  if (!(key in DEFAULTS)) throw new Error(`not a setting: ${key}`);
  cases.push({
    id: `settings.ui-to-bridge.${key}`,
    title: `${key}: changed in the app's Settings, the bridge has it`,
    needs: ['settings'],
    steps: [
      { do: 'act', action: 'settings.ui', args: { key, value: a }, expect: { ok: true } },
      { do: 'until', probe: 'http', path: '/api/config', timeoutMs: 5000, expect: { [`body.settings.${key}`]: a } },
    ],
  });
  const viaBridge = b === DEFAULTS[key] ? a : b; // never the default: the screen must really change
  cases.push({
    id: `settings.bridge-to-ui.${key}`,
    title: `${key}: changed through the bridge, the app's Settings shows it live`,
    needs: ['settings'],
    steps: [
      { do: 'http', method: 'POST', path: '/api/settings', body: { [key]: viaBridge }, expect: { status: 200 } },
      { do: 'until', probe: 'act', action: 'settings.read', args: { key }, timeoutMs: 5000, expect: { ok: true, value: viaBridge } },
    ],
  });
}
cases.push({
  id: 'settings.hotkey.change',
  title: "The wake hotkey changed in Settings is registered, shown, and saved in the core's settings",
  needs: ['settings', 'hotkey'],
  steps: [
    { do: 'act', action: 'settings.ui', args: { key: 'wakeHotkey', value: 'Control+Alt+K' }, expect: { ok: true } },
    { do: 'until', probe: 'state', timeoutMs: 3000, expect: { 'hotkey.accelerator': 'Control+Alt+K', 'hotkey.registered': true, 'hotkey.label': { $match: 'K' } } },
    { do: 'until', probe: 'http', path: '/api/config', timeoutMs: 3000, expect: { 'body.settings.wakeHotkey': 'Control+Alt+K' } },
  ],
});
cases.push({
  id: 'settings.hotkey.rejects-bad',
  title: 'A shortcut that is not valid is refused and the old one stays',
  needs: ['settings', 'hotkey'],
  steps: [
    { do: 'state', expect: { 'hotkey.registered': true } },
    { do: 'save', from: 'state', path: 'hotkey.accelerator', as: 'before' },
    { do: 'act', action: 'settings.ui', args: { key: 'wakeHotkey', value: 'Nonsense+++' }, expect: { ok: false } },
    { do: 'state', expect: { 'hotkey.accelerator': '${before}', 'hotkey.registered': true } },
  ],
});
cases.push({
  id: 'settings.login.toggle',
  title: 'Open at login turns on and off (a fake login item in tests)',
  needs: ['settings', 'login'],
  env: { ORBIT_FAKE_LOGIN: '1' },
  steps: [
    { do: 'state', expect: { 'login.enabled': false } },
    { do: 'act', action: 'settings.ui', args: { key: 'openAtLogin', value: true }, expect: { ok: true } },
    { do: 'until', probe: 'state', timeoutMs: 3000, expect: { 'login.enabled': true } },
    { do: 'act', action: 'settings.ui', args: { key: 'openAtLogin', value: false }, expect: { ok: true } },
    { do: 'until', probe: 'state', timeoutMs: 3000, expect: { 'login.enabled': false } },
  ],
});
cases.push({
  id: 'settings.survive-restart',
  title: 'Settings changed in the app are there after it restarts (same profile)',
  needs: ['settings'],
  profile: { settings: { avatar: 'qubit', speed: 1.3, announce: 'chime' } },
  steps: [{ do: 'until', probe: 'http', path: '/api/config', timeoutMs: 3000, expect: { 'body.settings.avatar': 'qubit', 'body.settings.speed': 1.3, 'body.settings.announce': 'chime' } }],
});
const doc = { area: 'settings', about: 'Generated by parity/tools/gen-settings-cases.mjs from src/config.js DEFAULTS. Every setting the Settings screen shows, both ways, plus the shell-owned ones.', cases };
fs.writeFileSync(path.join(HERE, '..', 'cases', 'settings-roundtrip.json'), JSON.stringify(doc, null, 1) + '\n');
console.log(`${cases.length} settings cases`);
