// A test build's first run: copy the real Orbit's plain settings and speech models into the test
// build's own data folder, so it opens ready for the Claude engine. Real Orbit's folder is only ever
// read. These two things are all it touches: no key files, no Local State, no logs, no profile.
//
// The copied settings change in three ways, so the two apps stay out of each other's way:
//   - its own wake hotkey (both can't hold one global shortcut),
//   - no apps under Orbit (that list could lead the test build to restart Discord or OpenCode, which
//     real Orbit may be holding),
//   - updates off, as the test build has none.
import fs from 'node:fs';
import path from 'node:path';

const MODELS = 'claude-voice-models';

/** What the test build keeps of real Orbit's settings. */
export function seededSettings(real, { hotkey }) {
  const out = { ...real, wakeHotkey: hotkey, autoUpdate: false };
  delete out.anywhereUnderOrbit;
  return out;
}

/**
 * Once only: a data folder with a settings file is left as it is. Returns what it did, for the log.
 * Never throws: a test build that can't be seeded simply starts as a new install.
 */
export async function seedTestData({ from, to, hotkey }) {
  const settings = path.join(to, 'settings.json');
  if (fs.existsSync(settings)) return { seeded: false, why: 'already has settings' };
  let real;
  try {
    real = JSON.parse(fs.readFileSync(path.join(from, 'settings.json'), 'utf8'));
  } catch {
    return { seeded: false, why: 'no real settings to copy' };
  }
  if (!real || typeof real !== 'object' || Array.isArray(real)) return { seeded: false, why: 'real settings unreadable' };
  fs.mkdirSync(to, { recursive: true });
  const models = path.join(from, MODELS);
  let copiedModels = false;
  if (fs.existsSync(models)) {
    try {
      await fs.promises.cp(models, path.join(to, MODELS), { recursive: true, force: false, errorOnExist: false });
      copiedModels = true;
    } catch {
      // Claude voice offers the download instead.
    }
  }
  fs.writeFileSync(settings, JSON.stringify(seededSettings(real, { hotkey }), null, 2));
  return { seeded: true, models: copiedModels };
}
