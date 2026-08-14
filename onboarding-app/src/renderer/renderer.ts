import { PROVIDERS } from "../providers";
import type {
  ConnectionInfo,
  ConnectionPhase,
  OnboardingApi,
  ProviderId,
} from "../types";

declare global {
  interface Window {
    onboarding: OnboardingApi;
  }
}

const api = window.onboarding;

const PHASE_TEXT: Record<ConnectionPhase, string> = {
  discovering: "Contacting provider…",
  registering: "Registering client…",
  waiting_for_browser: "Waiting for sign-in in your browser…",
  exchanging: "Finishing sign-in…",
  verifying: "Verifying the credential…",
};

const IDLE_NOTE =
  "Credentials are encrypted with your system keychain and stay on this device.";
const DONE_NOTE =
  "All three tools are connected. Your workspace is ready — you can close this window.";

type StepState =
  | { kind: "idle" }
  | { kind: "busy"; phase: ConnectionPhase }
  | { kind: "connected"; connection: ConnectionInfo }
  | { kind: "error"; message: string };

const state = new Map<ProviderId, StepState>(
  PROVIDERS.map((p) => [p.id, { kind: "idle" } as StepState]),
);

const stepsEl = document.getElementById("steps")!;
const progressEl = document.getElementById("progress")!;
const noteEl = document.getElementById("note")!;

function statusText(s: StepState): { text: string; data: string } {
  switch (s.kind) {
    case "idle":
      return { text: "Not connected", data: "idle" };
    case "busy":
      return { text: PHASE_TEXT[s.phase], data: "busy" };
    case "connected":
      return {
        text: s.connection.account
          ? `Connected as ${s.connection.account}`
          : "Connected",
        data: "connected",
      };
    case "error":
      return { text: s.message, data: "error" };
  }
}

function render(): void {
  const anyBusy = [...state.values()].some((s) => s.kind === "busy");
  stepsEl.replaceChildren(
    ...PROVIDERS.map((provider) => {
      const s = state.get(provider.id)!;
      const row = document.createElement("div");
      row.className = "tc-step";

      const body = document.createElement("div");
      body.className = "tc-step-body";
      const name = document.createElement("h2");
      name.className = "tc-step-name";
      name.textContent = provider.name;
      const desc = document.createElement("p");
      desc.className = "tc-step-desc";
      desc.textContent = provider.description;
      const status = document.createElement("p");
      status.className = "tc-step-status";
      const st = statusText(s);
      status.dataset.state = st.data;
      status.textContent = st.text;
      body.append(name, desc, status);

      const button = document.createElement("button");
      button.className = "vbg-button";
      button.type = "button";
      if (s.kind === "connected") {
        button.textContent = "Disconnect";
        button.addEventListener("click", () => disconnect(provider.id));
      } else {
        button.textContent = s.kind === "error" ? "Try again" : "Connect";
        button.disabled = anyBusy;
        button.addEventListener("click", () => connect(provider.id));
      }

      row.append(body, button);
      return row;
    }),
  );

  const connected = [...state.values()].filter(
    (s) => s.kind === "connected",
  ).length;
  progressEl.textContent = `${connected} of ${PROVIDERS.length} connected`;
  noteEl.textContent = connected === PROVIDERS.length ? DONE_NOTE : IDLE_NOTE;
}

async function connect(providerId: ProviderId): Promise<void> {
  state.set(providerId, { kind: "busy", phase: "discovering" });
  render();
  const result = await api.connect(providerId);
  if (result.ok && result.connection) {
    state.set(providerId, { kind: "connected", connection: result.connection });
  } else {
    state.set(providerId, {
      kind: "error",
      message: result.error ?? "Sign-in failed",
    });
  }
  render();
}

async function disconnect(providerId: ProviderId): Promise<void> {
  await api.disconnect(providerId);
  state.set(providerId, { kind: "idle" });
  render();
}

api.onProgress(({ providerId, phase }) => {
  const current = state.get(providerId);
  if (current?.kind === "busy") {
    state.set(providerId, { kind: "busy", phase });
    render();
  }
});

async function init(): Promise<void> {
  const saved = await api.getConnections();
  for (const provider of PROVIDERS) {
    const connection = saved[provider.id];
    if (connection) state.set(provider.id, { kind: "connected", connection });
  }
  render();
}

init();
