// Which apps "Mute my mic in other apps while Grok listens" may mute.
//
// Apps are matched by program file name (e.g. "discord.exe"), lowercase. The user picks what
// happens to apps they haven't decided on (micStealDefault: 'mute' = mute all except..., 'leave'
// = mute only...) and can override any single app (micStealRules: { "discord.exe": "mute" }).

/**
 * Left alone unless the user says otherwise. Recording apps would lose your voice from a
 * recording; audio-routing apps capture the real mic and pass it on as a virtual mic, so muting
 * them can silence everything downstream (Orbit included).
 */
export const BUILTIN_LEAVE = Object.freeze({
  'obs64.exe': 'OBS Studio',
  'obs32.exe': 'OBS Studio',
  'obs.exe': 'OBS Studio',
  'streamlabs obs.exe': 'Streamlabs',
  'streamlabs desktop.exe': 'Streamlabs',
  'xsplit.core.exe': 'XSplit',
  'xsplit.broadcaster.exe': 'XSplit',
  'cap.exe': 'Cap',
  'loom.exe': 'Loom',
  'camtasiarecorder.exe': 'Camtasia Recorder',
  'bdcam.exe': 'Bandicam',
  'medal.exe': 'Medal',
  'voicemoddesktop.exe': 'Voicemod',
  'voicemod.exe': 'Voicemod',
  'voicemeeter.exe': 'Voicemeeter',
  'voicemeeter_x64.exe': 'Voicemeeter',
  'voicemeeterpro.exe': 'Voicemeeter Banana',
  'voicemeeterpro_x64.exe': 'Voicemeeter Banana',
  'voicemeeter8.exe': 'Voicemeeter Potato',
  'voicemeeter8x64.exe': 'Voicemeeter Potato',
  'krisp.exe': 'Krisp',
  'nvidia broadcast.exe': 'NVIDIA Broadcast',
  'nvidia rtx voice.exe': 'NVIDIA RTX Voice',
  'steelseriessonar.exe': 'SteelSeries Sonar',
  'audacity.exe': 'Audacity',
  'reaper.exe': 'REAPER',
});

export const MAX_RULES = 200;
// A program file name: no path separators or characters Windows forbids in file names, ends in .exe.
const EXE = /^[^\\/:*?"<>|\t\r\n]{1,100}\.exe$/i;
export const isExeName = (s) => typeof s === 'string' && EXE.test(s);

/** What happens to one app: 'mute' or 'leave', and why ('you', 'recording-or-routing', 'default'). */
export function decide(exe, { micStealDefault = 'mute', micStealRules = {} } = {}) {
  const name = String(exe || '').toLowerCase();
  if (micStealRules[name]) return { action: micStealRules[name], why: 'you' };
  if (BUILTIN_LEAVE[name]) return { action: 'leave', why: 'recording-or-routing' };
  return { action: micStealDefault, why: 'default' };
}

/** The rules sent to the helper: the default, plus the apps to always mute or always leave. */
export function helperRules({ micStealDefault = 'mute', micStealRules = {} } = {}) {
  const mute = [];
  const leave = [];
  for (const [exe, action] of Object.entries(micStealRules)) (action === 'mute' ? mute : leave).push(exe);
  for (const exe of Object.keys(BUILTIN_LEAVE)) if (!micStealRules[exe]) leave.push(exe);
  return { default: micStealDefault, mute, leave };
}

/** The helper command for these rules (tab-separated; '|' can't occur in a file name). */
export const rulesCommand = (r) => `rules\t${r.default}\t${r.mute.join('|')}\t${r.leave.join('|')}`;
