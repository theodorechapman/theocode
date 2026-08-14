import { contextBridge, ipcRenderer } from "electron";
import type { OnboardingApi, ProviderId } from "./types";
import type { SessionRef, WorkspaceApi } from "./theocode/types";

const onboarding: OnboardingApi = {
  getConnections: () => ipcRenderer.invoke("connections:get"),
  connect: (providerId: ProviderId) =>
    ipcRenderer.invoke("oauth:connect", providerId),
  disconnect: (providerId: ProviderId) =>
    ipcRenderer.invoke("connections:disconnect", providerId),
  onProgress: (cb) => {
    ipcRenderer.on("oauth:progress", (_event, update) => cb(update));
  },
};

const workspace: WorkspaceApi = {
  getTree: () => ipcRenderer.invoke("workspace:tree"),
  createProject: () => ipcRenderer.invoke("workspace:createProject"),
  createSession: (projectId: string) =>
    ipcRenderer.invoke("workspace:createSession", projectId),
  getEvents: (ref: SessionRef) => ipcRenderer.invoke("workspace:events", ref),
  sendMessage: (ref: SessionRef, text: string) =>
    ipcRenderer.invoke("workspace:send", ref, text),
  onEvent: (cb) => {
    ipcRenderer.on("workspace:event", (_event, update) => cb(update));
  },
};

contextBridge.exposeInMainWorld("onboarding", onboarding);
contextBridge.exposeInMainWorld("workspace", workspace);
