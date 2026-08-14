import Lenis from "lenis";
import { button, h } from "./dom";
import { type EffortControl, mountEffortControl } from "./effort";
import { showSetupDialog } from "./setup";
import { eventBlock, isWatchedTool, PartialView } from "./transcript";
import type { ReasoningEffort } from "../theocode/reasoning";
import type {
  SessionEvent,
  SessionMeta,
  SessionRef,
  WorkspaceApi,
  WorkspaceTree,
} from "../theocode/types";

declare global {
  interface Window {
    workspace: WorkspaceApi;
  }
}

const api = window.workspace;

let tree: WorkspaceTree = { projects: [] };
let activeTurnKeys = new Set<string>();
let selected: SessionRef | null = null;
/** The project whose tab is active; the sidebar lists its sessions. */
let activeProjectId: string | null = null;

// --- Evidence tabs: sanity-check links opened from transcripts ---------------

interface EvidenceTab {
  id: string;
  projectId: string;
  kind: "url" | "image" | "text";
  /** URL for kind url; absolute file path otherwise. */
  target: string;
  title: string;
}
let evidenceTabs: EvidenceTab[] = [];
let activeEvidenceId: string | null = null;

function evidenceKindFor(path: string): "image" | "text" {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path) ? "image" : "text";
}

function evidenceTitle(kind: EvidenceTab["kind"], target: string): string {
  if (kind === "url") {
    try {
      const u = new URL(target);
      return u.host + (u.pathname === "/" ? "" : u.pathname);
    } catch {
      return target;
    }
  }
  return target.split("/").pop() || target;
}

function sessionCwd(): string | undefined {
  if (!selected) return undefined;
  const { session, projectPath } = findMeta(selected);
  return session?.worktree?.path ?? projectPath;
}

/** Opens (or refocuses) an evidence tab for a transcript link. */
function openEvidence(href: string): void {
  if (!selected) return;
  let kind: EvidenceTab["kind"];
  let target = href;
  if (/^https?:\/\//i.test(href)) {
    kind = "url";
  } else {
    if (target.startsWith("file://")) target = decodeURI(target.slice(7));
    if (!target.startsWith("/")) {
      const base = sessionCwd();
      if (!base) return;
      target = `${base}/${target}`.replace(/\/\.\//g, "/");
    }
    kind = evidenceKindFor(target);
  }
  const projectId = selected.projectId;
  const existing = evidenceTabs.find(
    (t) => t.projectId === projectId && t.target === target,
  );
  const tab = existing ?? {
    id: `ev-${Date.now()}-${evidenceTabs.length}`,
    projectId,
    kind,
    target,
    title: evidenceTitle(kind, target),
  };
  if (!existing) evidenceTabs.push(tab);
  activeEvidenceId = tab.id;
  renderTabs();
  renderPane();
}

function closeEvidence(id: string): void {
  evidenceTabs = evidenceTabs.filter((t) => t.id !== id);
  if (activeEvidenceId === id) activeEvidenceId = null;
  renderTabs();
  renderPane();
}
let events: SessionEvent[] = [];

let tabsEl: HTMLElement;
let treeEl: HTMLElement;
let paneEl: HTMLElement;
let transcriptEl: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let partialView: PartialView | null = null;
let partialHadText = false;
let selectedProjectPath: string | undefined;
let composerRipple: HTMLElement | null = null;
let effortUi: EffortControl | null = null;

const PROJECT_TONES = [
  "sky",
  "mint",
  "peach",
  "lilac",
  "butter",
  "rose",
  "aqua",
  "iris",
] as const;

function projectTone(id: string): (typeof PROJECT_TONES)[number] {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PROJECT_TONES[(hash >>> 0) % PROJECT_TONES.length];
}

function isResearch(meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.question);
}

function isResearchPrompt(event: SessionEvent): boolean {
  return (
    event.type === "user_message" &&
    typeof event.text === "string" &&
    event.text.startsWith("Research question:\n\n")
  );
}

function turnKeyOf(ref: SessionRef): string {
  return `${ref.projectId}/${ref.sessionId}/${ref.subagentId ?? ""}`;
}

function selectedIsActive(): boolean {
  return selected !== null && activeTurnKeys.has(turnKeyOf(selected));
}

function makeRipple(opts?: { research?: boolean; idle?: boolean }): HTMLElement {
  const ripple = h("span", "tc-ripple", h("span"), h("span"), h("span"));
  if (opts?.research) ripple.classList.add("tc-ripple-research");
  if (opts?.idle) ripple.classList.add("is-idle");
  ripple.setAttribute("role", "img");
  ripple.setAttribute("aria-label", "Turn running");
  return ripple;
}

function eyeglassIcon(): HTMLElement {
  const wrap = h("span", "tc-tree-research-icon");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", "Research");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const mark = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  svg.append(
    mark("circle", {
      cx: "7",
      cy: "7",
      r: "4.1",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.4",
    }),
    mark("path", {
      d: "M10.1 10.1L14 14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
    }),
  );
  wrap.append(svg);
  return wrap;
}

function syncComposerRipple(): void {
  if (!composerRipple) return;
  composerRipple.classList.toggle("is-idle", !selectedIsActive());
}

// --- Streaming scroll -------------------------------------------------------
//
// Lenis drives the transcript scroll (smooth, native-wrapping). Auto-follow
// is strictly one-directional: it glides down toward a stop line and never
// scrolls back up, so the reader is free to roam while a turn streams.
// The stop line is:
//  - the bottom, while thinking / unwatched tools stream by;
//  - a shell/python/edit tool block for a 2s hold when it appears — the
//    highest-signal view of what the agent is doing;
//  - the top of the agent message currently streaming (presumed final):
//    the scroll stops there, without pinning the reader to it.
let lenis: Lenis | null = null;
let lenisRaf = 0;
let turnAnchorEl: HTMLElement | null = null;
let anchorKind: "message" | "tool" | null = null;
let holdUntil = 0;
let watchKey: string | null = null;
let follow = true;

const TOOL_HOLD_MS = 2000;

// Event types whose arrival means the matching streamed partial just flushed.
const FLUSH_TYPES = new Set([
  "agent_message",
  "thought",
  "tool_call",
  "turn_end",
  "turn_error",
]);

function sameRef(a: SessionRef | null, b: SessionRef): boolean {
  return (
    a !== null &&
    a.projectId === b.projectId &&
    a.sessionId === b.sessionId &&
    a.subagentId === b.subagentId
  );
}

async function select(ref: SessionRef | null): Promise<void> {
  selected = ref;
  activeEvidenceId = null;
  if (ref) activeProjectId = ref.projectId;
  events = ref ? await api.getEvents(ref) : [];
  renderTabs();
  renderTree();
  renderPane();
}

// --- Top bar: one tab per project, plus "+" to add one ----------------------

async function createProjectFlow(): Promise<void> {
  const project = await api.createProject();
  if (!project) return;
  tree = await api.getTree();
  activeProjectId = project.id;
  await select(null);
  if (!project.setupPromptedAt) {
    const detection = await api.getSetupInfo(project.id);
    if (detection.alreadySetUp) {
      // The project carries its own setup marker (.theocode/setup.json):
      // never re-prompt, just record that we saw it.
      void api.setupSeen(project.id);
      return;
    }
    showSetupDialog(api, project, detection, async (ref) => {
      tree = await api.getTree();
      await select(ref);
    });
  }
}

function renderTabs(): void {
  const tabs = tree.projects.map(({ project, sessions }) => {
    const tab = button("tc-tab", "", async () => {
      if (activeProjectId === project.id && selected) return;
      activeProjectId = project.id;
      const first = sessions[0]?.session;
      await select(
        first ? { projectId: project.id, sessionId: first.id } : null,
      );
    });
    tab.dataset.tone = projectTone(project.id);
    tab.append(h("span", "tc-tab-swatch"), h("span", "tc-tab-name", project.name));
    tab.title = project.path;
    if (project.id === activeProjectId) tab.setAttribute("aria-current", "true");
    // Two-finger click: native context menu with "Close project".
    tab.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const closed = await api.projectMenu(project.id);
      if (!closed) return;
      tree = await api.getTree();
      if (activeProjectId === project.id) {
        activeProjectId = tree.projects[0]?.project.id ?? null;
        const next = tree.projects[0]?.sessions[0]?.session;
        await select(
          next ? { projectId: next.projectId, sessionId: next.id } : null,
        );
      } else {
        renderTabs();
        renderTree();
      }
    });
    const group = [tab];
    for (const ev of evidenceTabs.filter((t) => t.projectId === project.id)) {
      const evTab = button("tc-tab tc-tab-evidence", "", () => {
        activeProjectId = project.id;
        activeEvidenceId = ev.id;
        renderTabs();
        renderPane();
      });
      evTab.dataset.tone = projectTone(project.id);
      if (ev.id === activeEvidenceId) evTab.setAttribute("aria-current", "true");
      const closeEl = h("span", "tc-evidence-close", "×");
      closeEl.setAttribute("role", "button");
      closeEl.setAttribute("aria-label", `Close ${ev.title}`);
      closeEl.addEventListener("click", (e) => {
        e.stopPropagation();
        closeEvidence(ev.id);
      });
      evTab.append(h("span", "tc-tab-name", ev.title), closeEl);
      evTab.title = ev.target;
      group.push(evTab);
    }
    return group;
  });
  const add = button("tc-tab tc-tab-add", "+", () => void createProjectFlow());
  add.setAttribute("aria-label", "New project");
  add.title = "New project";
  tabsEl.replaceChildren(...tabs.flat(), add);
}

// --- Sidebar tree: the active project's sessions → subagent sessions --------

function sessionRow(
  meta: SessionMeta,
  ref: SessionRef,
  kind: "session" | "subagent",
): HTMLElement {
  const row = button("tc-tree-row", "", () => select(ref));
  row.classList.add(`tc-tree-${kind}`);
  if (sameRef(selected, ref)) row.setAttribute("aria-current", "true");
  const research = isResearch(meta);
  if (research) row.dataset.kind = "research";
  const active = activeTurnKeys.has(turnKeyOf(ref));
  if (active) row.append(makeRipple({ research }));
  row.append(
    h("span", "tc-tree-title", meta.title),
    ...(meta.worktree
      ? [
          h(
            "span",
            "tc-tree-badge",
            meta.worktree.label ?? `wt-${meta.worktree.n}`,
          ),
        ]
      : []),
    ...(research
      ? [eyeglassIcon()]
      : kind === "subagent"
        ? [h("span", "tc-tree-badge", "subagent")]
        : []),
  );
  return row;
}

function renderTree(): void {
  const node = tree.projects.find((p) => p.project.id === activeProjectId);
  if (!node) {
    treeEl.replaceChildren(
      h(
        "p",
        "tc-tree-empty",
        tree.projects.length > 0
          ? "Pick a project tab above."
          : "Create a project (+) to start.",
      ),
    );
    return;
  }

  const { project, sessions } = node;
  const head = h(
    "div",
    "tc-tree-project-head",
    h("span", "tc-tree-project-name", "Sessions"),
    button("tc-tree-add", "+", async () => {
      const session = await api.createSession(project.id);
      tree = await api.getTree();
      await select({ projectId: project.id, sessionId: session.id });
    }),
  );

  const rows: HTMLElement[] = [];
  for (const { session, subagents } of sessions) {
    const ref: SessionRef = { projectId: project.id, sessionId: session.id };
    rows.push(sessionRow(session, ref, "session"));
    if (subagents.length > 0) {
      rows.push(
        h(
          "div",
          "tc-tree-subagents",
          ...subagents.map((sub) =>
            sessionRow(sub, { ...ref, subagentId: sub.id }, "subagent"),
          ),
        ),
      );
    }
  }
  if (sessions.length === 0) {
    rows.push(h("p", "tc-tree-empty", "No sessions yet"));
  }

  treeEl.replaceChildren(head, ...rows);
}

// --- Main pane: transcript --------------------------------------------------

function findMeta(ref: SessionRef): {
  session?: SessionMeta;
  project?: string;
  projectPath?: string;
} {
  const projectNode = tree.projects.find((p) => p.project.id === ref.projectId);
  const sessionNode = projectNode?.sessions.find(
    (s) => s.session.id === ref.sessionId,
  );
  const session = ref.subagentId
    ? sessionNode?.subagents.find((s) => s.id === ref.subagentId)
    : sessionNode?.session;
  return {
    session,
    project: projectNode?.project.name,
    projectPath: projectNode?.project.path,
  };
}

function scrollTarget(): number {
  if (!transcriptEl) return 0;
  const bottom = transcriptEl.scrollHeight - transcriptEl.clientHeight;
  if (!turnAnchorEl?.isConnected) return bottom;
  return Math.min(bottom, Math.max(0, turnAnchorEl.offsetTop - 8));
}

function followStream(immediate = false): void {
  if (!transcriptEl || !lenis || !follow) return;
  // A tool hold that has run its course releases back to bottom-following.
  if (anchorKind === "tool" && performance.now() >= holdUntil) {
    turnAnchorEl = null;
    anchorKind = null;
    watchKey = null;
  }
  const target = scrollTarget();
  // Forward-only: glide down toward the stop line, never drag the reader
  // back up to it — the scroll stops there, it doesn't pin there.
  if (target > transcriptEl.scrollTop + 1) {
    lenis.scrollTo(target, immediate ? { immediate: true } : { duration: 0.5 });
  }
}

function patchSessionEffort(ref: SessionRef, effort: ReasoningEffort): void {
  const projectNode = tree.projects.find((p) => p.project.id === ref.projectId);
  const sessionNode = projectNode?.sessions.find(
    (s) => s.session.id === ref.sessionId,
  );
  if (!sessionNode) return;
  if (ref.subagentId) {
    const sub = sessionNode.subagents.find((s) => s.id === ref.subagentId);
    if (sub) sub.reasoningEffort = effort;
  } else {
    sessionNode.session.reasoningEffort = effort;
  }
}

function renderEvidencePane(tab: EvidenceTab): void {
  const head = h(
    "header",
    "tc-evidence-head",
    h("h1", "tc-pane-title", tab.title),
    button("tc-quiet-button", "Open externally", () => {
      window.open(tab.kind === "url" ? tab.target : `file://${tab.target}`);
    }),
  );
  const body = h("div", "tc-evidence-body");
  if (tab.kind === "url") {
    const web = document.createElement("webview");
    web.setAttribute("src", tab.target);
    web.className = "tc-evidence-web";
    body.append(web);
  } else if (tab.kind === "image") {
    const img = document.createElement("img");
    img.src = `file://${tab.target}`;
    img.className = "tc-evidence-img";
    img.alt = tab.title;
    body.append(img);
  } else {
    const pre = h("pre", "tc-evidence-text", "Loading…");
    body.append(pre);
    void api.readTextFile(tab.target).then((res) => {
      if (!res.ok) {
        pre.textContent = res.error ?? "Could not read file";
        return;
      }
      let text = res.text ?? "";
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON — show as-is.
      }
      pre.textContent = text;
    });
  }
  paneEl.replaceChildren(h("div", "tc-pane tc-evidence-pane", head, body));
}

function renderPane(): void {
  const evidence = evidenceTabs.find((t) => t.id === activeEvidenceId);
  if (evidence) {
    renderEvidencePane(evidence);
    return;
  }
  if (lenisRaf) cancelAnimationFrame(lenisRaf);
  lenis?.destroy();
  lenis = null;
  lenisRaf = 0;
  transcriptEl = null;
  contentEl = null;
  composerRipple = null;
  partialView = null;
  partialHadText = false;
  turnAnchorEl = null;
  anchorKind = null;
  holdUntil = 0;
  watchKey = null;
  follow = true;
  effortUi?.destroy();
  effortUi = null;

  if (!selected) {
    paneEl.replaceChildren(
      h(
        "div",
        "tc-pane",
        h(
          "div",
          "tc-empty",
          h("h1", "vbg-heading-20", "No session selected"),
          h(
            "p",
            "tc-empty-copy",
            "Pick a session from the sidebar, or create a project to start one.",
          ),
        ),
      ),
    );
    return;
  }

  const { session, project, projectPath } = findMeta(selected);
  selectedProjectPath = projectPath;
  const sessionRef = selected;
  const effort = mountEffortControl({
    session,
    onChange: async (effort) => {
      const updated = await api.setReasoningEffort(sessionRef, effort);
      if (updated?.reasoningEffort) {
        patchSessionEffort(sessionRef, updated.reasoningEffort);
      }
    },
  });
  effortUi = effort;

  // Research subagents pin their question above the scrolling transcript.
  // Older sessions without the metadata fall back to parsing the first prompt.
  let question = session?.question;
  if (!question && selected.subagentId) {
    const first = events.find((e) => e.type === "user_message");
    const match = /^Research question:\n\n([\s\S]*?)\n\nAnswer this question/.exec(
      typeof first?.text === "string" ? first.text : "",
    );
    if (match) question = match[1];
  }
  const research = Boolean(question);
  const header = h(
    "header",
    "tc-pane-head",
    h(
      "div",
      "tc-pane-title-group",
      h("h1", "tc-pane-title", session?.title ?? "Session"),
      h(
        "p",
        "tc-pane-context",
        [
          project,
          research
            ? "research"
            : selected.subagentId
              ? "subagent session"
              : "agent session",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    ),
    effort.trigger,
  );
  const banner = question
    ? h(
        "div",
        "tc-question-banner",
        h("p", "tc-question-label", "Question"),
        h("p", "tc-question-text", question),
      )
    : null;

  // Thinking stays pinned above the composer, outside the scroll flow.
  const thinkingStrip = h("div", "tc-thinking-strip");
  partialView = new PartialView(selectedProjectPath, thinkingStrip);
  transcriptEl = h("div", "tc-transcript");
  contentEl = h("div", "tc-transcript-inner");
  transcriptEl.append(contentEl);
  if (events.length === 0) {
    contentEl.append(
      h("p", "tc-tree-empty tc-placeholder", "No records in this session yet."),
    );
  } else {
    for (const e of events) {
      if (research && isResearchPrompt(e)) continue;
      const block = eventBlock(e, false, selectedProjectPath);
      // Historical load: land anchored on the last significant block.
      if (e.type === "agent_message") {
        turnAnchorEl = block;
        anchorKind = "message";
      } else if (e.type === "tool_call" || e.type === "user_message") {
        turnAnchorEl = null;
        anchorKind = null;
      }
      // Sequential Reads collapse into the same line in history too.
      const last = contentEl.lastElementChild;
      if (
        block.classList.contains("tc-tool-read") &&
        last?.classList.contains("tc-tool-read")
      ) {
        last.replaceWith(block);
      } else {
        contentEl.append(block);
      }
    }
  }
  contentEl.append(partialView.el);

  lenis = new Lenis({ wrapper: transcriptEl, content: contentEl });
  const loop = (time: number) => {
    lenis?.raf(time);
    lenisRaf = requestAnimationFrame(loop);
  };
  lenisRaf = requestAnimationFrame(loop);
  // Scrolling up hands control to the reader; scrolling back down to the
  // stop line re-engages auto-follow.
  transcriptEl.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY < 0) follow = false;
      else if (transcriptEl && transcriptEl.scrollTop >= scrollTarget() - 60) {
        follow = true;
      }
    },
    { passive: true },
  );

  // Research subagents are agent-driven; the UI never offers a prompt.
  let composer: HTMLElement | null = null;
  if (!research) {
    const input = h("textarea", "tc-composer-input") as HTMLTextAreaElement;
    input.rows = 2;
    input.placeholder = "Message the agent…";
    const send = button("vbg-button", "Send", async () => {
      const text = input.value.trim();
      if (!text || !selected) return;
      input.value = "";
      await api.sendMessage(selected, text);
      // The session takes its title from the latest prompt — refresh the
      // sidebar and patch the header in place (no pane rebuild mid-turn).
      tree = await api.getTree();
      renderTree();
      const title = findMeta(selected).session?.title;
      const titleEl = paneEl.querySelector(".tc-pane-title");
      if (title && titleEl) titleEl.textContent = title;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send.click();
      }
    });
    composerRipple = makeRipple({ idle: !selectedIsActive() });
    composer = h(
      "footer",
      "tc-composer",
      h("div", "tc-composer-row", input, h("div", "tc-composer-send", composerRipple, send)),
      h(
        "p",
        "vbg-caption",
        "Enter to send. Shift+Enter for a new line. Esc to interrupt.",
      ),
    );
  }

  paneEl.replaceChildren(
    h(
      "div",
      "tc-pane",
      header,
      ...(banner ? [banner] : []),
      transcriptEl,
      thinkingStrip,
      ...(composer ? [composer] : []),
    ),
    effort.layer,
  );
  followStream(true);
}

export async function initWorkspace(container: HTMLElement): Promise<void> {
  tabsEl = document.getElementById("tabs")!;
  treeEl = document.getElementById("tree")!;
  paneEl = container;
  paneEl.classList.add("tc-workspace-view");

  // Transcript links become evidence tabs instead of leaving the app.
  paneEl.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a[href]");
    if (!a || !paneEl.contains(a)) return;
    e.preventDefault();
    openEvidence(a.getAttribute("href")!);
  });

  // Escape closes the effort slide-out first; otherwise it interrupts
  // the in-flight turn for the selected session.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (effortUi?.isOpen()) {
      e.preventDefault();
      effortUi.close();
      return;
    }
    if (selected) void api.interruptTurn(selected);
  });

  api.onEvent(({ ref, event }) => {
    if (!sameRef(selected, ref)) return;
    if (events.some((e) => e.seq === event.seq)) return;
    events.push(event);
    if (isResearch(findMeta(ref).session) && isResearchPrompt(event)) return;
    if (!contentEl || !partialView) return;
    contentEl.querySelector(".tc-placeholder")?.remove();
    // A flushed message replaces its streamed partial; paragraphs that were
    // already visible while streaming keep still, only later ones fade in.
    const fadeFrom =
      event.type === "agent_message" && partialHadText
        ? partialView.shownTextBlocks()
        : 0;
    if (FLUSH_TYPES.has(event.type)) {
      partialView.update(null);
      partialHadText = false;
    }
    const block = eventBlock(event, true, selectedProjectPath, fadeFrom);
    // Sequential Reads collapse into one line: the newest swaps out the last.
    const prev = partialView.el.previousElementSibling;
    if (
      block.classList.contains("tc-tool-read") &&
      prev?.classList.contains("tc-tool-read")
    ) {
      prev.replaceWith(block);
    } else {
      contentEl.insertBefore(block, partialView.el);
    }
    if (event.type === "user_message") {
      // A new turn: follow the bottom until there is something to hold on.
      turnAnchorEl = null;
      anchorKind = null;
      watchKey = null;
      follow = true;
    } else if (event.type === "agent_message") {
      turnAnchorEl = block;
      anchorKind = "message";
      watchKey = null;
    } else if (event.type === "tool_call") {
      const watched = isWatchedTool(
        String(event.toolName ?? ""),
        typeof event.kind === "string" ? event.kind : undefined,
        typeof event.command === "string" ? event.command : undefined,
      );
      if (watched) {
        // Its streamed partial (same key) may already be mid-hold; a
        // watched call arriving cold gets the full 2s on its output.
        const key = String(event.command ?? event.toolCallId ?? event.seq);
        turnAnchorEl = block;
        anchorKind = "tool";
        if (key !== watchKey) {
          watchKey = key;
          holdUntil = performance.now() + TOOL_HOLD_MS;
        }
      } else {
        turnAnchorEl = null;
        anchorKind = null;
        watchKey = null;
      }
    }
    // thought / turn_end / notice keep the current stop line in place.
    followStream();
  });

  api.onActiveTurns((keys) => {
    activeTurnKeys = new Set(keys);
    renderTree();
    syncComposerRipple();
  });

  api.onTreeChanged(async () => {
    tree = await api.getTree();
    renderTree();
  });

  api.onPartial(({ ref, partial }) => {
    if (!sameRef(selected, ref) || !partialView) return;
    partialHadText = Boolean(partial?.text);
    partialView.update(partial);
    if (partial?.text) {
      turnAnchorEl = partialView.textEl();
      anchorKind = "message";
      watchKey = null;
    } else if (partial?.tool) {
      const toolEl = partialView.watchedToolEl();
      if (toolEl) {
        // A shell/python/edit call: hold the scroll on it for 2 seconds.
        const key = partial.tool.command ?? partial.tool.toolName;
        turnAnchorEl = toolEl;
        anchorKind = "tool";
        if (key !== watchKey) {
          watchKey = key;
          holdUntil = performance.now() + TOOL_HOLD_MS;
        }
      } else {
        turnAnchorEl = null;
        anchorKind = null;
        watchKey = null;
      }
    }
    // Thought-only partials keep the current stop line (thinking is pinned
    // above the composer and adds nothing to the transcript).
    followStream();
  });

  tree = await api.getTree();
  activeTurnKeys = new Set(await api.getActiveTurns());
  activeProjectId = tree.projects[0]?.project.id ?? null;
  const first = tree.projects[0]?.sessions[0]?.session;
  await select(
    first ? { projectId: first.projectId, sessionId: first.id } : null,
  );
}

export async function refreshWorkspace(): Promise<void> {
  tree = await api.getTree();
  if (!activeProjectId && tree.projects.length > 0) {
    activeProjectId = tree.projects[0].project.id;
  }
  renderTabs();
  renderTree();
  renderPane();
}
