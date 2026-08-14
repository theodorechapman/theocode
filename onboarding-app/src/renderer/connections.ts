import { button, h } from "./dom";
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
const DONE_NOTE = "All three tools are connected. Your workspace is ready.";

type StepState =
  | { kind: "idle" }
  | { kind: "busy"; phase: ConnectionPhase }
  | { kind: "connected"; connection: ConnectionInfo }
  | { kind: "error"; message: string };

const state = new Map<ProviderId, StepState>(
  PROVIDERS.map((p) => [p.id, { kind: "idle" } as StepState]),
);

let stepsEl: HTMLElement;
let progressEl: HTMLElement;
let noteEl: HTMLElement;

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
      const st = statusText(s);
      const status = h("p", "tc-step-status", st.text);
      status.dataset.state = st.data;
      const body = h(
        "div",
        "tc-step-body",
        h("h2", "tc-step-name", provider.name),
        h("p", "tc-step-desc", provider.description),
        status,
      );
      const action =
        s.kind === "connected"
          ? button("vbg-button", "Disconnect", () => disconnect(provider.id))
          : button("vbg-button", s.kind === "error" ? "Try again" : "Connect", () =>
              connect(provider.id),
            );
      if (s.kind !== "connected") action.disabled = anyBusy;
      return h("div", "tc-step", body, action);
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

export async function initConnections(
  container: HTMLElement,
  onBack: () => void,
): Promise<void> {
  progressEl = h("p", "vbg-meta tc-progress", "0 of 3 connected");
  progressEl.setAttribute("aria-live", "polite");
  stepsEl = h("div", "tc-steps");
  noteEl = h("p", "vbg-caption tc-note", IDLE_NOTE);
  noteEl.setAttribute("aria-live", "polite");

  container.replaceChildren(
    h(
      "header",
      "tc-pane-head",
      h(
        "div",
        "tc-pane-title-group",
        h("h1", "tc-pane-title", "Connections"),
        h(
          "p",
          "tc-pane-context",
          "Sign in to each service. Every connection opens your browser, completes there, and returns here on its own.",
        ),
      ),
      button("tc-quiet-button", "Back to sessions", onBack),
    ),
    progressEl,
    stepsEl,
    noteEl,
  );

  api.onProgress(({ providerId, phase }) => {
    const current = state.get(providerId);
    if (current?.kind === "busy") {
      state.set(providerId, { kind: "busy", phase });
      render();
    }
  });

  const saved = await api.getConnections();
  for (const provider of PROVIDERS) {
    const connection = saved[provider.id];
    if (connection) state.set(provider.id, { kind: "connected", connection });
  }
  render();
}
