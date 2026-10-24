const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('webInput', { report: (s) => ipcRenderer.send('state', s) });
