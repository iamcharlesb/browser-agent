/**
 * Preload bridge for the Open Bots desktop shell.
 * Exposes a small IPC API so the renderer can dock the Live Browser WebContentsView.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openBotsDesktop", {
  isDesktop: true,
  platform: process.platform,
  reportBrowserBounds(bounds) {
    ipcRenderer.send("live-browser:bounds", bounds);
  },
  setLiveBrowserVisible(visible) {
    ipcRenderer.send("live-browser:visible", Boolean(visible));
  },
  browserCommand(input) {
    return ipcRenderer.invoke("workspace:browser-command", input);
  },
  getBrowserState() {
    return ipcRenderer.invoke("workspace:browser-state");
  },
  onBrowserState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("workspace:browser-state", listener);
    return () => ipcRenderer.removeListener("workspace:browser-state", listener);
  }
});
