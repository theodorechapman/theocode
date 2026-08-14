import { contextBridge, ipcRenderer } from "electron";
import type { OnboardingApi, ProviderId } from "./types";

const api: OnboardingApi = {
  getConnections: () => ipcRenderer.invoke("connections:get"),
  connect: (providerId: ProviderId) =>
    ipcRenderer.invoke("oauth:connect", providerId),
  disconnect: (providerId: ProviderId) =>
    ipcRenderer.invoke("connections:disconnect", providerId),
  onProgress: (cb) => {
    ipcRenderer.on("oauth:progress", (_event, update) => cb(update));
  },
};

contextBridge.exposeInMainWorld("onboarding", api);
