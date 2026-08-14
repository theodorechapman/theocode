import { button, h } from "./dom";
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
let selected: SessionRef | null = null;
let events: SessionEvent[] = [];
const collapsedProjects = new Set<string>();

let treeEl: HTMLElement;
let paneEl: HTMLElement;

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
  events = ref ? await api.getEvents(ref) : [];
  renderTree();
  renderPane();
}

// --- Sidebar tree: project → agent session → subagent sessions -------------

function sessionRow(
  meta: SessionMeta,
  ref: SessionRef,
  kind: "session" | "subagent",
): HTMLElement {
  const row = button("tc-tree-row", "", () => select(ref));
  row.classList.add(`tc-tree-${kind}`);
  if (sameRef(selected, ref)) row.setAttribute("aria-current", "true");
  row.append(
    h("span", "tc-tree-title", meta.title),
    ...(kind === "subagent" ? [h("span", "tc-tree-badge", "subagent")] : []),
  );
  return row;
}

function renderTree(): void {
  const groups = tree.projects.map(({ project, sessions }) => {
    const group = h("section", "tc-tree-project");
    const head = h("div", "tc-tree-project-head");
    const disclosure = button(
      "tc-tree-disclosure",
      collapsedProjects.has(project.id) ? "▸" : "▾",
      () => {
        if (!collapsedProjects.delete(project.id)) collapsedProjects.add(project.id);
        renderTree();
      },
    );
    disclosure.setAttribute(
      "aria-label",
      `${collapsedProjects.has(project.id) ? "Expand" : "Collapse"} ${project.name}`,
    );
    head.append(
      disclosure,
      h("span", "tc-tree-project-name", project.name),
      button("tc-tree-add", "+", async () => {
        const session = await api.createSession(project.id);
        tree = await api.getTree();
        await select({ projectId: project.id, sessionId: session.id });
      }),
    );
    group.append(head);

    if (!collapsedProjects.has(project.id)) {
      for (const { session, subagents } of sessions) {
        const ref: SessionRef = { projectId: project.id, sessionId: session.id };
        group.append(sessionRow(session, ref, "session"));
        if (subagents.length > 0) {
          group.append(
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
        group.append(h("p", "tc-tree-empty", "No sessions yet"));
      }
    }
    return group;
  });

  treeEl.replaceChildren(
    ...(groups.length > 0
      ? groups
      : [h("p", "tc-tree-empty", "Create a project to start a session.")]),
  );
}

// --- Main pane: stubbed chat ------------------------------------------------

function findMeta(ref: SessionRef): { session?: SessionMeta; project?: string } {
  const projectNode = tree.projects.find((p) => p.project.id === ref.projectId);
  const sessionNode = projectNode?.sessions.find(
    (s) => s.session.id === ref.sessionId,
  );
  const session = ref.subagentId
    ? sessionNode?.subagents.find((s) => s.id === ref.subagentId)
    : sessionNode?.session;
  return { session, project: projectNode?.project.name };
}

function eventBlock(event: SessionEvent): HTMLElement {
  const { seq, at, type, ...rest } = event;
  const time = at ? new Date(at).toLocaleTimeString() : "";
  const body =
    typeof rest.text === "string" ? rest.text : JSON.stringify(rest, null, 2);
  return h(
    "article",
    "tc-event",
    h("p", "tc-event-meta", `${seq} · ${type} · ${time}`),
    h("pre", "tc-event-body", body),
  );
}

function renderPane(): void {
  if (!selected) {
    paneEl.replaceChildren(
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
    );
    return;
  }

  const { session, project } = findMeta(selected);
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
        [project, selected.subagentId ? "subagent session" : "agent session"]
          .filter(Boolean)
          .join(" · "),
      ),
    ),
  );

  const transcript = h("div", "tc-transcript");
  if (events.length === 0) {
    transcript.append(h("p", "tc-tree-empty", "No records in this session yet."));
  } else {
    transcript.append(...events.map(eventBlock));
  }

  const input = h("textarea", "tc-composer-input") as HTMLTextAreaElement;
  input.rows = 2;
  input.placeholder = "Message the agent…";
  const send = button("vbg-button", "Send", async () => {
    const text = input.value.trim();
    if (!text || !selected) return;
    input.value = "";
    events = await api.sendMessage(selected, text);
    renderPane();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send.click();
    }
  });
  const composer = h(
    "footer",
    "tc-composer",
    h("div", "tc-composer-row", input, send),
    h(
      "p",
      "vbg-caption",
      "Chat rendering is stubbed: records above are the raw session log. Messages are stored; the agent turn is not wired yet.",
    ),
  );

  paneEl.replaceChildren(header, transcript, composer);
  transcript.scrollTop = transcript.scrollHeight;
}

export async function initWorkspace(container: HTMLElement): Promise<void> {
  treeEl = document.getElementById("tree")!;
  paneEl = container;

  document.getElementById("new-project")!.addEventListener("click", async () => {
    const project = await api.createProject();
    if (!project) return;
    tree = await api.getTree();
    renderTree();
  });

  api.onEvent(({ ref, event }) => {
    if (sameRef(selected, ref)) {
      if (!events.some((e) => e.seq === event.seq)) events.push(event);
      renderPane();
    }
  });

  tree = await api.getTree();
  const first = tree.projects[0]?.sessions[0]?.session;
  await select(
    first ? { projectId: first.projectId, sessionId: first.id } : null,
  );
}

export async function refreshWorkspace(): Promise<void> {
  tree = await api.getTree();
  renderTree();
  renderPane();
}
