// Narrow bridge from the game to the desktop shell (Steam achievements).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowlineDesktop', {
  isDesktop: true,
  unlockAchievement: (id) => ipcRenderer.invoke('steam:achievement', id),
  steamAvailable: () => ipcRenderer.invoke('steam:available'),
});
