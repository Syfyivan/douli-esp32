const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("douliDesktop", Object.freeze({
  getStatus: () => ipcRenderer.invoke("douli:status"),
  retry: () => ipcRenderer.invoke("douli:retry"),
  openLogs: () => ipcRenderer.invoke("douli:logs"),
  onBackground: callback => {
    const listener = () => callback();
    ipcRenderer.on("douli:background", listener);
    return () => ipcRenderer.removeListener("douli:background", listener);
  },
}));
