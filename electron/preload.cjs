// Exposes a tiny, fixed API to the page as window.desktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
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
  buddyHover: (on) => ipcRenderer.send('buddy:hover', !!on),
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
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  startWithWindows: {
    get: () => ipcRenderer.invoke('app:get-login'),
    set: (enabled) => ipcRenderer.invoke('app:set-login', !!enabled),
  },
  hotkey: {
    get: () => ipcRenderer.invoke('hotkey:get'),
    set: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),
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
