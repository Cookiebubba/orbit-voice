// Exposes a tiny, fixed API to the page as window.desktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // 'win32' | 'darwin' | 'linux': for platform-aware words (hotkey symbols, "Open at login").
  platform: process.platform,
  managed: process.argv.includes('--host-managed-ui'),
  managedStatus: (status) => ipcRenderer.send('managed:status', status),
  managedAck: (id, applied) => ipcRenderer.send('managed:ack', id, applied === true),
  onManagedControl: (cb) => {
    const fn = (_e, message) => cb(message);
    ipcRenderer.on('managed:control', fn);
    return () => ipcRenderer.removeListener('managed:control', fn);
  },
  onOpenSettings: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('external:open-settings', fn);
    return () => ipcRenderer.removeListener('external:open-settings', fn);
  },
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  sendOrbState: (s) => ipcRenderer.send('orb:state', s),
  onOrbState: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('orb:state', fn);
    return () => ipcRenderer.removeListener('orb:state', fn);
  },
  onOrbAction: (cb) => {
    const fn = (_e, a) => cb(a);
    ipcRenderer.on('orb:action', fn);
    return () => ipcRenderer.removeListener('orb:action', fn);
  },
  orbRestore: () => ipcRenderer.send('orb:restore'),
  orbAction: (a) => ipcRenderer.send('orb:action', a),
  orbDragStart: () => ipcRenderer.send('orb:drag-start'),
  orbDragMove: () => ipcRenderer.send('orb:drag-move'),
  orbDragEnd: () => ipcRenderer.send('orb:drag-end'),
  // The avatar (the pixel buddy or Qubit): the main window tells it what happened; its own window
  // gets Orbit's state and says when the cursor is over it (so it can take clicks).
  buddyEvent: (name) => ipcRenderer.send('buddy:event', name),
  buddyHover: (on, held) => ipcRenderer.send('buddy:hover', !!on, !!held),
  // A genuine avatar press starts a bounded native release/cursor watch; no input is injected.
  buddyGesture: (message) => ipcRenderer.send('buddy:gesture', message && typeof message === 'object' ? { phase: message.phase, id: message.id, revision: message.revision } : null),
  onBuddyGesture: (cb) => {
    const fn = (_e, sample) => cb(sample);
    ipcRenderer.on('buddy:gesture', fn);
    return () => ipcRenderer.removeListener('buddy:gesture', fn);
  },
  // A press on the avatar and what came of it ('click' | 'pickup' | 'ignored', and why), for the log.
  buddyPress: (outcome, why) => ipcRenderer.send('buddy:press', String(outcome), String(why || '')),
  // Where the avatar is drawn (its window's px), so its window takes the mouse there.
  buddyHit: (r) => ipcRenderer.send('buddy:hit', r && typeof r === 'object' ? { x: +r.x, y: +r.y, w: +r.w, h: +r.h, revision: r.revision === undefined ? 0 : r.revision, ...(Array.isArray(r.controls) ? { controls: r.controls.slice(0, 2).map((c) => ({ x: +c.x, y: +c.y, w: +c.w, h: +c.h })) } : {}) } : null),
  // The real cursor near the avatar's window (screen px; null: away), polled by Orbit itself.
  onBuddyCursor: (cb) => {
    const fn = (_e, c) => cb(c);
    ipcRenderer.on('buddy:cursor', fn);
    return () => ipcRenderer.removeListener('buddy:cursor', fn);
  },
  // A quick click on the avatar: start talking (as "Hey Orbit" with its window in front).
  buddyTalk: () => ipcRenderer.send('buddy:talk'),
  buddySettings: () => ipcRenderer.send('buddy:settings'),
  buddyVoice: (action) => { if (action === 'start' || action === 'stop') ipcRenderer.send('buddy:voice', action); },
  onAvatarVoice: (cb) => {
    const fn = (_e, action) => cb(action);
    ipcRenderer.on('avatar:voice', fn);
    return () => ipcRenderer.removeListener('avatar:voice', fn);
  },
  // Picked up (true) or put back (false): the avatar's window covers the work area meanwhile.
  buddyLift: (on) => ipcRenderer.send('buddy:lift', !!on),
  // Thrown for real: the main window plays its sound.
  buddySound: (name) => ipcRenderer.send('buddy:sound', String(name)),
  // The main window: an avatar's sound to play ('throw').
  onAvatarSound: (cb) => {
    const fn = (_e, name) => cb(name);
    ipcRenderer.on('avatar:sound', fn);
    return () => ipcRenderer.removeListener('avatar:sound', fn);
  },
  // The main window: the avatar was clicked to talk.
  onAvatarTalk: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('avatar:talk', fn);
    return () => ipcRenderer.removeListener('avatar:talk', fn);
  },
  // A feeling as the voice's words play (an emote cue: 'happy', 'surprised'...), for Qubit.
  buddyEmote: (name) => ipcRenderer.send('buddy:emote', String(name)),
  onBuddyEmote: (cb) => {
    const fn = (_e, name) => cb(name);
    ipcRenderer.on('buddy:emote', fn);
    return () => ipcRenderer.removeListener('buddy:emote', fn);
  },
  onBuddyState: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('buddy:state', fn);
    return () => ipcRenderer.removeListener('buddy:state', fn);
  },
  onBuddyEvent: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('buddy:event', fn);
    return () => ipcRenderer.removeListener('buddy:event', fn);
  },
  // Something the user asked the avatar to do ({ action, dir }): "do a backflip".
  onBuddyCommand: (cb) => {
    const fn = (_e, c) => cb(c);
    ipcRenderer.on('buddy:command', fn);
    return () => ipcRenderer.removeListener('buddy:command', fn);
  },
  // Orbit's mouse (its overlay page): where to draw the cursor, and Orbit's voice state.
  onMouseState: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('mouse:state', fn);
    return () => ipcRenderer.removeListener('mouse:state', fn);
  },
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  startWithWindows: {
    get: () => ipcRenderer.invoke('app:get-login'),
    set: (enabled) => ipcRenderer.invoke('app:set-login', !!enabled),
  },
  hotkey: {
    get: () => ipcRenderer.invoke('hotkey:get'),
    set: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),
    enable: (enabled) => ipcRenderer.invoke('hotkey:enable', !!enabled),
    suspend: (suspended) => ipcRenderer.invoke('hotkey:suspend', suspended),
  },
  updates: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onChange: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('update:state', fn);
      return () => ipcRenderer.removeListener('update:state', fn);
    },
  },
  onHotkey: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('hotkey', fn);
    return () => ipcRenderer.removeListener('hotkey', fn);
  },
});
