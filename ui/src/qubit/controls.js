import { avatarVoiceStatus } from '../buddy/interactions.js';

// Out of the way unless wanted: shown while the cursor is on him or on the bubble, while its
// button has focus, and for a moment after the voice state actually changes.
export const REVEAL_MS = 3000;
export const LINGER_MS = 1500;

// The same voice owner as Orbit's hotkey, with state from its actual microphone/audio gate.
export function createVoiceControl({ desktop, parent = document.body }) {
  const style = document.createElement('style');
  style.textContent = `.qubit-voice{position:fixed;z-index:2;display:flex;align-items:center;gap:10px;padding:4px 4px 4px 10px;border:1px solid #d6d8dc;border-radius:8px;background:#fff;color:#333840;font:12px/1.2 Inter,'Segoe UI',system-ui,sans-serif;white-space:nowrap;user-select:none;touch-action:none}.qubit-voice[hidden]{display:none}.qubit-voice[data-listening=true]{color:#126438}.qubit-voice button{border:0;border-radius:4px;min-height:28px;min-width:44px;padding:0 9px;background:#202329;color:#fff;font:500 12px Inter,'Segoe UI',system-ui,sans-serif;cursor:pointer}.qubit-voice button:hover{background:#353a43}.qubit-voice button:focus-visible{outline:2px solid #546ce8;outline-offset:2px}.qubit-voice span{display:flex;gap:6px;align-items:center}.qubit-voice svg{width:14px;height:14px;flex:none}`;
  document.head.append(style);
  const box = document.createElement('div'); box.className = 'qubit-voice'; box.dataset.avatarControl = ''; box.hidden = true;
  const label = document.createElement('span'); label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
  const text = document.createElement('span');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5m-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6'); svg.append(path);
  const slash = document.createElementNS(svg.namespaceURI, 'path'); slash.setAttribute('d', 'M3 3l18 18'); svg.append(slash);
  const button = document.createElement('button'); button.type = 'button';
  label.append(svg, text); box.append(label, button); parent.append(box);
  let state = avatarVoiceStatus(), prior = '', measured = null, revealUntil = 0, over = false;
  box.addEventListener('pointerenter', () => { over = true; });
  box.addEventListener('pointerleave', () => { over = false; revealUntil = Math.max(revealUntil, performance.now() + LINGER_MS); });
  button.addEventListener('click', (event) => { event.stopPropagation(); if (state.action === 'settings') desktop?.buddySettings?.(); else desktop?.buddyVoice?.(state.action); });
  box.addEventListener('dblclick', (event) => event.stopPropagation());
  return {
    hide() { box.hidden = true; over = false; },
    update(voice, { x, y, radius, width, height, visible = true, held = false, hovering = false, now = performance.now() }) {
      state = avatarVoiceStatus(voice);
      const key = JSON.stringify(state);
      if (key !== prior) {
        if (prior) revealUntil = Math.max(revealUntil, now + REVEAL_MS); // a change, not the first state
        measured = null;
        prior = key; text.textContent = state.label; button.textContent = state.button;
        button.setAttribute('aria-label', state.action === 'settings' ? 'Open Orbit settings' : state.action === 'start' ? 'Start voice' : 'Stop voice');
        button.title = state.action === 'start' ? 'Start talking to Orbit' : state.action === 'stop' ? 'Stop voice and release the microphone' : 'Open Orbit settings';
        slash.style.display = state.listening ? 'none' : ''; box.dataset.listening = String(!!state.listening);
      }
      if (hovering) revealUntil = Math.max(revealUntil, now + LINGER_MS);
      const wanted = over || now < revealUntil || box.matches(':focus-within');
      box.hidden = !visible || held || !wanted;
      if (box.hidden) { over = false; return null; }
      measured ||= { w: box.offsetWidth, h: box.offsetHeight };
      const { w, h } = measured;
      let left = x + radius + 8;
      if (left + w > width - 4) left = x - radius - 8 - w;
      const top = Math.min(height - h - 4, Math.max(4, y - h / 2));
      left = Math.max(4, Math.min(width - w - 4, left));
      box.style.left = `${left}px`; box.style.top = `${top}px`;
      return { x: left, y: top, w, h };
    },
  };
}
