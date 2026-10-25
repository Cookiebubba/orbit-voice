// Whether Orbit can start talking, and what the main page says when it can't. Plain JS (with
// talk.d.ts) so the tests run it in node.
//
// Claude voice runs on the user's own Claude Code sign-in (their Claude plan): no xAI key. Grok
// voice needs an xAI key. The main page always shows (the avatar, the orb); a key is only asked
// for, inline, when someone tries to talk to Grok without one.

export const GROK_NEEDS_KEY = 'Grok voice needs an xAI key. Add one in Settings, or switch to Claude voice.';
export const CLAUDE_CODE_MISSING = "Claude voice needs Claude Code on this computer. Install it, or set where it is in Settings → Second brain.";

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
 * try found it. `status`: GET /api/claude-voice ({ claudeFound, models: { state, percent, error } }).
 * It clears by itself once the reason is gone (a key saved, Claude chosen, the models ready).
 */
export function talkNotice(blocked, config, status) {
  if (blocked === 'grok-key') return canTalk(config) ? null : { kind: 'grok-key', text: GROK_NEEDS_KEY };
  if (blocked !== 'claude' || config?.settings?.voiceEngine !== 'claude' || !status) return null;
  if (!status.claudeFound) return { kind: 'claude-missing', text: CLAUDE_CODE_MISSING };
  const m = status.models || {};
  if (m.state === 'ready') return null;
  if (m.state === 'error') return { kind: 'claude-models-error', text: `Claude voice's speech models didn't download: ${m.error || 'unknown error'}. Try again, or download them in Settings.` };
  return { kind: 'claude-models', text: `Getting Claude voice ready: downloading its speech models${m.state === 'downloading' ? `… ${m.percent || 0}%` : '…'}` };
}

/** Before a call starts on Claude voice: start the models' download if they're not here yet. */
export function needsModelDownload(status) {
  return !!status?.claudeFound && (status.models?.state === 'idle' || status.models?.state === 'error');
}
