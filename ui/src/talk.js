// Whether Orbit can start talking, and what the main page says when it can't. Plain JS (with
// talk.d.ts) so the tests run it in node.
//
// Claude voice runs on the user's own Claude Code sign-in (their Claude plan): no xAI key. Grok
// voice needs an xAI key. The main page always shows (the avatar, the orb); a key is only asked
// for, inline, when someone tries to talk to Grok without one.

export const GROK_NEEDS_KEY = 'Grok voice needs an xAI key. Add one in Settings, or switch to Claude voice.';

// Installing Claude Code (Anthropic's own instructions, code.claude.com/docs/en/setup): the native
// installer's one line for this system, and the guide for anyone who'd rather read it there.
export const CLAUDE_CODE_GUIDE = 'https://code.claude.com/docs/en/setup';
/** The native installer's command for `platform` (PowerShell on Windows; Terminal on a Mac). */
export function claudeInstallCommand(platform) {
  return platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
}
/** Claude Code isn't here: what to do, in the words of `platform`'s own terminal. */
export function claudeCodeMissing(platform) {
  const where = platform === 'win32' ? 'PowerShell and press Enter' : platform === 'darwin' ? 'Terminal and press Return' : 'a terminal and press Enter';
  return `Claude voice needs Claude Code (it runs on your Claude plan). Copy the install command, paste it into ${where}, then press Check again.`;
}
export const CLAUDE_CODE_MISSING = claudeCodeMissing('darwin');

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
 * `platform`: the desktop's (its terminal is named in the words for installing Claude Code).
 * It clears by itself once the reason is gone (a key saved, Claude chosen, the models ready).
 */
export function talkNotice(blocked, config, status, platform = 'darwin') {
  if (blocked === 'grok-key') return canTalk(config) ? null : { kind: 'grok-key', text: GROK_NEEDS_KEY };
  if (blocked !== 'claude' || config?.settings?.voiceEngine !== 'claude' || !status) return null;
  if (!status.claudeFound) return { kind: 'claude-missing', text: claudeCodeMissing(platform) };
  const m = status.models || {};
  if (m.state === 'ready') return null;
  if (m.state === 'error') return { kind: 'claude-models-error', text: `Claude voice's speech models didn't download: ${m.error || 'unknown error'}. Try again, or download them in Settings.` };
  return { kind: 'claude-models', text: `Getting Claude voice ready: downloading its speech models${m.state === 'downloading' ? `… ${m.percent || 0}%` : '…'}` };
}

/** Before a call starts on Claude voice: start the models' download if they're not here yet. */
export function needsModelDownload(status) {
  return !!status?.claudeFound && (status.models?.state === 'idle' || status.models?.state === 'error');
}
