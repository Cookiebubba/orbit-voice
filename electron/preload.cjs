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
  micLive: (live) => ipcRenderer.send('mic:live', !!live),
  orbDragStart: () => ipcRenderer.send('orb:drag-start'),
  orbDragMove: () => ipcRenderer.send('orb:drag-move'),
  orbDragEnd: () => ipcRenderer.send('orb:drag-end'),
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
  onHotkey: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('hotkey', fn);
    return () => ipcRenderer.removeListener('hotkey', fn);
  },
});
