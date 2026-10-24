const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('chatApp', { report: (s) => ipcRenderer.send('state', s) });
