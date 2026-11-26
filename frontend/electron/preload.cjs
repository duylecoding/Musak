const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musakBridge', {
  getKeyStatus: () => ipcRenderer.invoke('musak:get-key-status'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('musak:save-api-key', apiKey),
  clearApiKey: () => ipcRenderer.invoke('musak:clear-api-key'),
  openExternal: (url) => ipcRenderer.invoke('musak:open-external', url),
  getBackendUrl: () => ipcRenderer.invoke('musak:get-backend-url'),
  onApiKeySynced: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('musak:api-key-synced', listener);
    return () => ipcRenderer.removeListener('musak:api-key-synced', listener);
  },
});
