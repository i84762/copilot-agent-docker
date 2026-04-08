'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer (frontend JS)
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // Open native folder picker — resolves to path string or null
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // Open native file picker — resolves to path string or null
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),

  // Listen for project folder chosen via File > Open Project Folder…
  onOpenProject: (cb) => ipcRenderer.on('open-project', (_e, folderPath) => cb(folderPath)),
});
