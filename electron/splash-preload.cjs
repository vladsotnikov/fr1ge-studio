// Preload for the splash window. Exposes a tiny IPC surface to the splash
// page so we can keep nodeIntegration disabled (safer default).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("license", {
  validate: (key) => ipcRenderer.invoke("license:validate", key),
  accept: () => ipcRenderer.send("license:accepted")
});
