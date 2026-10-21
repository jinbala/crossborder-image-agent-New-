const { contextBridge, ipcRenderer, webUtils } = require('electron');

// A narrow bridge: renderer never receives Node.js, filesystem primitives or the API secret.
contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  chooseDirectory: () => ipcRenderer.invoke('desktop:choose-directory'),
  openDirectory: (key) => ipcRenderer.invoke('desktop:open-directory', key),
  exportSupport: () => ipcRenderer.invoke('desktop:export-support'),
  readLog: (query) => ipcRenderer.invoke('desktop:read-log', query),
  restartService: () => ipcRenderer.invoke('desktop:restart-service'),
  cloudInfo: () => ipcRenderer.invoke('desktop:cloud-info'),
  cloudConnect: (input) => ipcRenderer.invoke('desktop:cloud-connect', input),
  cloudSync: () => ipcRenderer.invoke('desktop:cloud-sync'),
  cloudResolve: (id, choice) => ipcRenderer.invoke('desktop:cloud-resolve', id, choice),
  cloudDisconnect: () => ipcRenderer.invoke('desktop:cloud-disconnect'),
  updateInfo: () => ipcRenderer.invoke('desktop:update-info'),
  updateCheck: () => ipcRenderer.invoke('desktop:update-check'),
  updateStage: () => ipcRenderer.invoke('desktop:update-stage'),
  updateInstall: (version) => ipcRenderer.invoke('desktop:update-install', version),
  updateImport: () => ipcRenderer.invoke('desktop:update-import'),
  configureRembg: () => ipcRenderer.invoke('desktop:configure-rembg'),
  droppedPaths: (files) => Array.from(files || []).map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  importDirectory: (directory) => ipcRenderer.invoke('desktop:import-directory', directory)
});
