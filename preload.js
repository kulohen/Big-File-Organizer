const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  preview: (folder, sizeText) => ipcRenderer.invoke('scan:preview', { folder, sizeText }),
  execute: (folder, sizeText) => ipcRenderer.invoke('scan:execute', { folder, sizeText }),
  onProgress: (cb) => ipcRenderer.on('exec:progress', (_e, data) => cb(data)),
});
