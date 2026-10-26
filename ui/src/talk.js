// Whether Orbit can start talking, and what the main page says when it can't. Plain JS (with
// talk.d.ts) so the tests run it in node.
//
// Claude voice runs on the user's own Claude Code sign-in (their Claude plan): no xAI key. Grok
// voice needs an xAI key. The main page always shows (the avatar, the orb); a key is only asked
// for, inline, when someone tries to talk to Grok without one.

export const GROK_NEEDS_KEY = 'Grok voice needs an xAI key. Add one in Settings, or switch to Claude voice.';
export const CLAUDE_CODE_MISSING = 'Claude voice needs Claude Code on this computer. To install it, paste this into a terminal:';
export const CLAUDE_NOT_SIGNED_IN = "Claude Code isn't signed in. Run claude once in a terminal and sign in with your Claude account.";
/** The line under the install command: Claude Code runs on the user's own Claude sign-in. */
export const CLAUDE_SIGN_IN_STEP = 'Then run claude once in a terminal and sign in with your Claude account.';
/** Anthropic's setup page (opened in the browser, never fetched by Orbit). */
export const CLAUDE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
/** The npm route, for people who'd rather (needs Node.js 22 or later). Not shown in the app. */
export const CLAUDE_NPM_INSTALL = 'npm install -g @anthropic-ai/claude-code';

/**
 * Claude Code's official install command for this platform, as Anthropic's setup page gives it.
 * Orbit only shows it (with Copy): it never runs an installer itself.
 */
export function claudeInstall(platform) {
  if (platform === 'win32') return { where: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' };
  return { where: platform === 'darwin' ? 'Terminal' : 'a terminal', command: 'curl -fsSL https://claude.ai/install.sh | bash' };
}

/** Claude voice, or Grok voice with a key saved. */
export function canTalk(config) {
  const engine = config?.settings?.voiceEngine;
  if (engine === 'claude') return true;
  return engine === 'grok' && !!config?.hasKey;
}

/** Which screen the window shows: Settings, History, or the main page (never a key screen). */
export function screenFor(view) {
  return view === 'settings' || view === 'history' ? view : 'main';
}

/**
 * The inline notice on the main page after a try to talk that couldn't start, or null.
 * `blocked`: 'grok-key' (tried Grok without a key) or 'claude' (Claude voice wasn't ready), as the
 * try found it. `status`: GET /api/claude-voice ({ claudeFound, signedIn, models: { state, percent, error } });
 * signedIn is null when it couldn't be checked, which never blocks.
 * It clears by itself once the reason is gone (a key saved, Claude chosen, the models ready).
 */
export function talkNotice(blocked, config, status) {
  if (blocked === 'grok-key') return canTalk(config) ? null : { kind: 'grok-key', text: GROK_NEEDS_KEY };
  if (blocked !== 'claude' || config?.settings?.voiceEngine !== 'claude' || !status) return null;
  if (!status.claudeFound) return { kind: 'claude-missing', text: CLAUDE_CODE_MISSING };
  if (status.signedIn === false) return { kind: 'claude-signed-out', text: CLAUDE_NOT_SIGNED_IN };
  const m = status.models || {};
  if (m.state === 'ready') return null;
  if (m.state === 'error') return { kind: 'claude-models-error', text: `Claude voice's speech models didn't download: ${m.error || 'unknown error'}. Try again, or download them in Settings.` };
  return { kind: 'claude-models', text: `Getting Claude voice ready: downloading its speech models${m.state === 'downloading' ? `… ${m.percent || 0}%` : '…'}` };
}

/** Before a call starts on Claude voice: start the models' download if they're not here yet. */
export function needsModelDownload(status) {
  return !!status?.claudeFound && (status.models?.state === 'idle' || status.models?.state === 'error');
}

/** Claude voice can start: Claude Code here, not known to be signed out, and the models ready. */
export function claudeVoiceReady(status) {
  return !!status?.claudeFound && status.signedIn !== false && status.models?.state === 'ready';
}

/**
 * The notice's "Check again": look for Claude Code (and its sign-in) again. `fetchStatus()`
 * resolves GET /api/claude-voice (or null); `startDownload()` resolves POST
 * /api/claude-voice/download, used only when Claude Code is now here but the models aren't.
 * Resolves { status, ready }: ready clears the notice; otherwise the notice follows `status`.
 */
export async function checkClaudeAgain({ fetchStatus, startDownload }) {
  let status = await Promise.resolve()
    .then(fetchStatus)
    .catch(() => null);
  if (!status) return { status: null, ready: false };
  if (status.claudeFound && status.signedIn !== false && needsModelDownload(status)) {
    const r = await Promise.resolve()
      .then(startDownload)
      .catch(() => null);
    if (r?.models) status = { ...status, models: r.models };
  }
  return { status, ready: claudeVoiceReady(status) };
}
