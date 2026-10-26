// The first-run onboarding, as Orbit Native's (mac-swift OnboardingModel + VoiceSetupView): "How
// should Orbit talk?", Claude voice or Grok voice, set up right there through the same bridge calls
// Settings uses. Plain JS (with onboarding-model.d.ts) so the tests run it in node.
//
// It shows once: a brand-new install starts with `onboarded: false` (src/config.js
// FIRST_RUN_SETTINGS); any install from before reads as done. "Continue" (once the chosen voice is
// ready), "Skip this step" and "Skip setup" each end it for good. Orbit Native's next steps are the
// Mac's permissions; Windows has none, so all three end the onboarding here.

/** Should the onboarding be on screen? Never under the parity suite (as Orbit Native with faked permissions). */
export function onboardingShown(settings, { parity = false } = {}) {
  return !parity && settings?.onboarded === false;
}

/** What "Continue", "Skip this step" and "Skip setup" save: the onboarding is done. */
export const ONBOARDING_DONE = Object.freeze({ onboarded: true });

/** The chosen engine, as the cards show it (anything but Grok is Claude). */
export const engineOf = (settings) => (settings?.voiceEngine === 'grok' ? 'grok' : 'claude');

/**
 * Everything the chosen voice needs is in place, so "Continue" can be pressed. Grok: an xAI key
 * saved. Claude: Claude Code here and signed in (GET /api/claude-voice); the speech models may still
 * be downloading (a call waits for them).
 */
export function voiceReady(engine, { hasKey = false, status = null } = {}) {
  if (engine === 'grok') return !!hasKey;
  return !!status?.claudeFound && status?.signedIn === true;
}

/** Choosing Claude voice downloads its speech models straight away (as choosing it in Settings does). */
export function shouldDownload(engine, status) {
  const st = status?.models?.state;
  return engine === 'claude' && !!st && st !== 'ready' && st !== 'downloading' && st !== 'error';
}

/**
 * Look again: GET /api/claude-voice (`fetchStatus`), and on Claude voice start the models' download
 * (`startDownload`: POST /api/claude-voice/download) when they're not here yet. Resolves the status,
 * or null when it couldn't be read.
 */
export async function refreshVoiceSetup({ engine, fetchStatus, startDownload }) {
  let status = await Promise.resolve()
    .then(fetchStatus)
    .catch(() => null);
  if (!status) return null;
  if (shouldDownload(engine, status)) {
    const r = await Promise.resolve()
      .then(startDownload)
      .catch(() => null);
    if (r?.models) status = { ...status, models: r.models };
  }
  return status;
}

/** "Claude Code" row: how it stands. */
export function claudeCodeDetail(status) {
  if (!status) return 'Checking…';
  return status.claudeFound ? 'Installed' : 'Not installed yet';
}

/** "Sign in" row: how it stands (`signingIn`: null, or { error } while or after pressing Sign in). */
export function signInDetail(status, signingIn) {
  if (status?.signedIn === true) return 'Signed in';
  if (!status?.claudeFound) return 'After Claude Code is installed';
  if (signingIn?.error) return signingIn.error;
  return signingIn ? 'Finish in the browser that opened…' : 'With your Claude account';
}

/** "Speech models" row: how they stand. */
export function modelsDetail(status, thisComputer = 'this PC') {
  if (!status) return 'Checking…';
  const m = status.models || {};
  if (m.state === 'ready') return 'Ready';
  if (m.state === 'downloading') return `Downloading… ${m.percent || 0}%`;
  if (m.state === 'error') return `Download failed: ${m.error || 'unknown error'}`;
  return `About ${status.mb} MB, kept on ${thisComputer}`;
}

/**
 * "Sign in": Claude Code's own sign-in (`login`: POST /api/brain/login), then a look every 3 s
 * (`fetchStatus`) until it says signed in, for up to 3 minutes. `onStatus` gets each look;
 * `cancelled()` stops it (the screen went away). Resolves { signedIn } or { error }.
 */
export async function signInAndWait({ login, fetchStatus, onStatus = () => {}, cancelled = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, everyMs = 3000, limitMs = 180_000 }) {
  let r;
  try {
    r = await login();
  } catch {
    return { error: "Couldn't reach Orbit." };
  }
  if (!r?.ok) return { error: r?.error || "Couldn't open the sign-in." };
  const since = now();
  while (!cancelled() && now() - since < limitMs) {
    await sleep(everyMs);
    if (cancelled()) break;
    const st = await Promise.resolve()
      .then(fetchStatus)
      .catch(() => null);
    if (st) onStatus(st);
    if (st?.signedIn === true) return { signedIn: true };
  }
  return { signedIn: false };
}
