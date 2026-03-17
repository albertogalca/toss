const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("toss", {
  getPathForFile: (file) => webUtils.getPathForFile(file),

  addFile: (filePath, password) => ipcRenderer.invoke("add-file", filePath, password),

  removeFile: (shareId) => ipcRenderer.invoke("remove-file", shareId),

  getFiles: () => ipcRenderer.invoke("get-files"),

  getShareUrl: (shareId) => ipcRenderer.invoke("get-share-url", shareId),

  getFilePassword: (shareId) => ipcRenderer.invoke("get-file-password", shareId),

  setFilePassword: (shareId, password) => ipcRenderer.invoke("set-file-password", shareId, password),

  getIceServers: () => ipcRenderer.invoke("get-ice-servers"),

  onTransferProgress: (callback) => {
    ipcRenderer.on("transfer-progress", (_event, data) => callback(data));
  },

  onConnectionStatus: (callback) => {
    ipcRenderer.on("connection-status", (_event, connected) => callback(connected));
    // Request current status in case we missed the initial event
    ipcRenderer.invoke("get-connection-status").then(callback);
  },

  onIncomingRequest: (callback) => {
    ipcRenderer.on("incoming-request", (_event, msg) => callback(msg));
  },

  sendSignal: (shareId, sessionId, data) => ipcRenderer.invoke("send-signal", shareId, sessionId, data),

  readFileChunk: (shareId, offset, length) =>
    ipcRenderer.invoke("read-file-chunk", shareId, offset, length),

  verifyPassword: (shareId, pw) => ipcRenderer.invoke("verify-password", shareId, pw),

  getPreferences: () => ipcRenderer.invoke("get-preferences"),
  setPreferences: (prefs) => ipcRenderer.invoke("set-preferences", prefs),
});
