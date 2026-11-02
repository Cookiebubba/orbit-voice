// Shared avatar actions. A settings double-click must never also wake the microphone.
export function createAvatarClicks({ single, double, delay = 500, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null, timer = null;
  const cancel = () => { clearTimer(timer); timer = null; pending = null; };
  return {
    begin() { clearTimer(timer); timer = null; },
    cancel,
    click(point) {
      const t = now();
      if (pending && t - pending.t <= delay && Math.hypot(point.x - pending.x, point.y - pending.y) <= 8) {
        cancel(); double(); return 'double';
      }
      cancel(); pending = { ...point, t };
      timer = setTimer(() => { pending = null; timer = null; single(); }, delay);
      return 'single';
    },
    setDelay(value) { if (Number.isFinite(value) && value >= 50 && value <= 5000) delay = value; },
  };
}

export function avatarVoiceStatus(voice = {}) {
  const active = voice.microphone === 'active';
  const on = voice.phase && voice.phase !== 'off';
  if (voice.microphone === 'denied') return { label: 'Mic blocked', action: 'settings', button: 'Settings' };
  if (!on || voice.asleep) return { label: 'Mic off', action: 'start', button: 'Start' };
  if (voice.phase === 'connecting') return { label: 'Connecting…', action: 'stop', button: 'Stop' };
  if (voice.muted) return { label: 'Mic muted', action: 'start', button: 'Unmute' };
  if (voice.listening === false || !active) return { label: voice.phase === 'speaking' ? 'Speaking · mic off' : 'Mic off', action: 'stop', button: 'Stop' };
  return { label: voice.phase === 'speaking' ? 'Speaking · mic on' : voice.phase === 'thinking' ? 'Thinking · mic on' : 'Listening', action: 'stop', button: 'Stop', listening: true };
}
