import { contextBridge, ipcRenderer } from "electron";
import type { OnboardingApi, ProviderId } from "./types";
import type { SessionRef, SetupAnswers, WorkspaceApi } from "./theocode/types";

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
  interruptTurn: (ref: SessionRef) =>
    ipcRenderer.invoke("workspace:interrupt", ref),
  listDirectory: (path: string) =>
    ipcRenderer.invoke("workspace:listDir", path),
  projectMenu: (projectId: string) =>
    ipcRenderer.invoke("workspace:projectMenu", projectId),
  onEvent: (cb) => {
    ipcRenderer.on("workspace:event", (_event, update) => cb(update));
  },
  onPartial: (cb) => {
    ipcRenderer.on("workspace:partial", (_event, update) => cb(update));
  },
  getActiveTurns: () => ipcRenderer.invoke("workspace:activeTurns"),
  onActiveTurns: (cb) => {
    ipcRenderer.on("workspace:active-turns", (_event, keys) => cb(keys));
  },
  onTreeChanged: (cb) => {
    ipcRenderer.on("workspace:tree-changed", () => cb());
  },
  getSetupInfo: (projectId: string) =>
    ipcRenderer.invoke("workspace:setupInfo", projectId),
  runSetup: (projectId: string, answers: SetupAnswers) =>
    ipcRenderer.invoke("workspace:runSetup", projectId, answers),
  setupSeen: (projectId: string) =>
    ipcRenderer.invoke("workspace:setupSeen", projectId),
};

contextBridge.exposeInMainWorld("onboarding", onboarding);
contextBridge.exposeInMainWorld("workspace", workspace);
