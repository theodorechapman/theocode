import { h } from "./dom";
import { highlightBash } from "./bash";
import { markdownBlocks } from "./markdown";
import type { SessionEvent, TurnPartial } from "../theocode/types";

// Event vocabulary → DOM. Design choices:
// - agent prose renders as full markdown at full width; each top-level block
//   is its own element so streaming fades them in one by one.
// - tool boxes are width-clamped (prose is not) and line-clamped to 5 lines,
//   click toggles the clip. Bash commands get syntax colors.
// - Read collapses to just the relative path; list_directory renders a
//   little file tree with directories highlighted.
// - tool slugs render as plain English ("run_shell_command" → "Shell").

const CLAMP_LINES = 5;
const TREE_LINES = 5;

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  read: "Read",
  list_directory: "List",
  ls: "List",
  run_shell_command: "Shell",
  execute_command: "Shell",
  shell: "Shell",
  bash: "Shell",
  run_python: "Python",
  python: "Python",
  edit_file: "Edit",
  write_file: "Write",
  create_file: "Create",
  apply_patch: "Edit",
  search_file_content: "Search",
  grep: "Search",
  glob: "Find files",
  find_files: "Find files",
  web_search: "Web search",
  web_fetch: "Fetch page",
  todo_write: "Plan",
  task: "Subagent",
};

/** "run_shell_command" → "Shell"; unknown slugs → "Run shell command". */
export function prettyToolName(toolName: string): string {
  const label = TOOL_LABELS[toolName.toLowerCase()];
  if (label) return label;
  const words = toolName
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Shell/python commands and file edits are the clearest signal of what the
 * agent is doing — the scroll pauses on these while they run.
 */
export function isWatchedTool(
  toolName: string,
  kind?: string,
  command?: string,
): boolean {
  if (command) return true;
  if (kind === "execute" || kind === "edit") return true;
  return /shell|bash|python|terminal|edit|write|patch|create|apply/i.test(
    toolName,
  );
}

function fade(el: HTMLElement, animate: boolean): HTMLElement {
  if (animate) el.classList.add("tc-fade");
  return el;
}

function clampable(
  className: string,
  text: string,
  content?: Node,
): HTMLElement {
  const el = h("pre", `${className} tc-clamp`);
  el.append(content ?? text);
  if (text.split("\n").length > CLAMP_LINES) {
    el.classList.add("tc-clampable");
    el.title = "Click to expand";
    el.addEventListener("click", () => {
      el.classList.toggle("tc-clamp");
      el.title = el.classList.contains("tc-clamp") ? "Click to expand" : "";
    });
  }
  return el;
}

/** Markdown blocks, each optionally fading in as it arrives. */
export function richBlocks(text: string, animate: boolean): HTMLElement[] {
  return markdownBlocks(text).map((block) => fade(block, animate));
}

/**
 * The streamed text up to its last completed paragraph (a blank line marks
 * completion). The still-typing tail is withheld so paragraphs land whole,
 * each with its fade — instead of a typewriter dribble that makes the fade
 * invisible. Never cuts inside an unclosed ``` fence.
 */
function completedPrefix(text: string): string {
  const cut = text.lastIndexOf("\n\n");
  if (cut < 0) return "";
  let done = text.slice(0, cut + 1);
  const fences = (done.match(/```/g) ?? []).length;
  if (fences % 2 === 1) done = done.slice(0, done.lastIndexOf("```"));
  return done;
}

function isReadTool(toolName: string, kind?: string): boolean {
  return kind === "read" || /^read/i.test(toolName);
}

function isListTool(toolName: string, kind?: string): boolean {
  return kind === "list" || /list.*dir|^ls$|^list$/i.test(toolName);
}

function inputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const path =
    raw.file_path ??
    raw.target_file ??
    raw.target_directory ??
    raw.path ??
    raw.filePath ??
    raw.directory;
  return typeof path === "string" && path ? path : null;
}

function relativePath(path: string, basePath?: string): string {
  if (basePath && path.startsWith(basePath)) {
    return path.slice(basePath.length).replace(/^\/+/, "") || ".";
  }
  return path;
}

// --- Directory tree rendering ----------------------------------------------

interface TreeNode {
  name: string;
  dir: boolean;
  children: TreeNode[];
}

/** Parse listing lines (flat names or nested paths, dirs end in "/"). */
function buildTree(lines: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const isDir = /\/$/.test(line);
    const segs = line.replace(/\/+$/, "").split("/").filter(Boolean);
    let list = roots;
    segs.forEach((seg, i) => {
      let node = list.find((n) => n.name === seg);
      if (!node) {
        node = { name: seg, dir: i < segs.length - 1 || isDir, children: [] };
        list.push(node);
      }
      if (i < segs.length - 1 || isDir) node.dir = true;
      list = node.children;
    });
  }
  return roots;
}

function treeRows(nodes: TreeNode[], prefix: string, out: HTMLElement[]): void {
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    out.push(
      h(
        "div",
        "tc-tree-line",
        h("span", "tc-tree-cnx", prefix + (last ? "└ " : "├ ")),
        h("span", node.dir ? "tc-dir" : "tc-file", node.name + (node.dir ? "/" : "")),
      ),
    );
    treeRows(node.children, prefix + (last ? "   " : "│  "), out);
  });
}

/** The listing as a little tree, 5 lines tall with ⋯ when clipped. */
function treeBox(output: string): HTMLElement {
  const lines = output.split("\n").filter((l) => l.trim());
  const rows: HTMLElement[] = [];
  // Output that is already tree-drawn (or indented) renders as-is, colored.
  const preDrawn = lines.some((l) => /^[\s│├└]/.test(l));
  if (preDrawn) {
    for (const line of lines) {
      rows.push(
        h("div", "tc-tree-line", h("span", /\/\s*$/.test(line) ? "tc-dir" : "tc-file", line)),
      );
    }
  } else {
    treeRows(buildTree(lines), "", rows);
  }

  const box = h("div", "tc-tree-box");
  let expanded = false;
  const render = () => {
    if (expanded || rows.length <= TREE_LINES) {
      box.replaceChildren(...rows);
      box.classList.remove("tc-tree-clipped");
    } else {
      box.replaceChildren(
        h("div", "tc-tree-ellipsis", "⋯"),
        ...rows.slice(0, TREE_LINES),
        h("div", "tc-tree-ellipsis", `⋯ ${rows.length - TREE_LINES} more`),
      );
      box.classList.add("tc-tree-clipped");
    }
  };
  render();
  if (rows.length > TREE_LINES) {
    box.classList.add("tc-clampable");
    box.title = "Click to expand";
    box.addEventListener("click", () => {
      expanded = !expanded;
      box.title = expanded ? "" : "Click to expand";
      render();
    });
  }
  return box;
}

// --- Tool blocks ------------------------------------------------------------

interface ToolBlockOpts {
  toolName: string;
  kind?: string;
  command?: string;
  input?: unknown;
  output?: string;
  status?: string;
  exitCode?: number;
  animate: boolean;
  basePath?: string;
}

function toolBlock(opts: ToolBlockOpts): HTMLElement {
  const { toolName, command, input, output, status, exitCode, animate } = opts;
  const statusText =
    status === "completed"
      ? typeof exitCode === "number" && exitCode !== 0
        ? `exit ${exitCode}`
        : ""
      : status === "failed"
        ? "failed"
        : "running…";
  const statusEl = statusText
    ? [h("span", `tc-tool-status${status === "failed" || exitCode ? " tc-tool-bad" : ""}`, statusText)]
    : [];

  // Read collapses to a single line: the relative path that was read.
  const readPath = isReadTool(toolName, opts.kind) ? inputPath(input) : null;
  if (readPath) {
    const head = h(
      "p",
      "tc-tool-head",
      h("span", "tc-tool-name", "Read"),
      h("span", "tc-tool-path", relativePath(readPath, opts.basePath)),
      ...statusEl,
    );
    return fade(h("article", "tc-tool tc-tool-read", head), animate);
  }

  // list_directory renders as a little file tree.
  if (isListTool(toolName, opts.kind)) {
    const dirPath = inputPath(input);
    const head = h(
      "p",
      "tc-tool-head",
      h("span", "tc-tool-name", "List"),
      ...(dirPath
        ? [h("span", "tc-tool-path", relativePath(dirPath, opts.basePath))]
        : []),
      ...statusEl,
    );
    const block = fade(h("article", "tc-tool", head), animate);
    if (output?.trim()) {
      block.append(treeBox(output));
    } else if (dirPath && status === "completed") {
      // Some list results carry no text (seen with grok's list_dir): fall
      // back to listing the directory ourselves — top entries, dirs first.
      const box = h("div", "tc-tree-box");
      block.append(box);
      void window.workspace.listDirectory(dirPath).then((lines) => {
        if (lines.length > 0) box.replaceWith(treeBox(lines.join("\n")));
        else box.replaceWith(h("div", "tc-tree-ellipsis", "(empty directory)"));
      });
    }
    return block;
  }

  const head = h(
    "p",
    "tc-tool-head",
    h("span", "tc-tool-name", prettyToolName(toolName)),
    ...statusEl,
  );
  const block = fade(h("article", "tc-tool", head), animate);
  if (command) {
    block.append(clampable("tc-tool-cmd", command, highlightBash(command)));
  } else if (input && Object.keys(input as object).length > 0) {
    block.append(clampable("tc-tool-cmd", JSON.stringify(input, null, 2)));
  }
  if (output?.trim()) block.append(clampable("tc-tool-out", output.trimEnd()));
  return block;
}

function metaLine(text: string, animate: boolean): HTMLElement {
  return fade(h("p", "tc-turn-meta", text), animate);
}

export function eventBlock(
  event: SessionEvent,
  animate: boolean,
  basePath?: string,
  /** For agent_message: blocks before this index were already visible while
   *  streaming, so only later ones fade in. */
  fadeFrom = 0,
): HTMLElement {
  const rest = event as Record<string, unknown>;
  switch (event.type) {
    case "user_message": {
      const block = fade(h("article", "tc-msg tc-msg-user"), animate);
      block.append(
        h("p", "tc-msg-label", "You"),
        ...richBlocks(String(rest.text ?? ""), false),
      );
      return block;
    }
    case "agent_message": {
      const block = fade(h("article", "tc-msg tc-msg-agent"), false);
      block.append(
        ...markdownBlocks(String(rest.text ?? "")).map((b, i) =>
          fade(b, animate && i >= fadeFrom),
        ),
      );
      return block;
    }
    case "thought": {
      const details = h("details", "tc-thought");
      details.append(
        h("summary", "tc-thought-summary", "Thinking"),
        h("p", "tc-thought-body", String(rest.text ?? "")),
      );
      return fade(details, animate);
    }
    case "tool_call":
      return toolBlock({
        toolName: String(rest.toolName ?? "tool"),
        kind: typeof rest.kind === "string" ? rest.kind : undefined,
        command: typeof rest.command === "string" ? rest.command : undefined,
        input: rest.input,
        output: typeof rest.output === "string" ? rest.output : undefined,
        status: typeof rest.status === "string" ? rest.status : undefined,
        exitCode: typeof rest.exitCode === "number" ? rest.exitCode : undefined,
        animate,
        basePath,
      });
    case "turn_end": {
      const tokens =
        typeof rest.totalTokens === "number"
          ? `${(rest.totalTokens / 1000).toFixed(1)}k tokens`
          : null;
      const cost =
        typeof rest.costUsd === "number" ? `$${rest.costUsd.toFixed(3)}` : null;
      return metaLine(
        ["turn finished", rest.stopReason, tokens, cost]
          .filter(Boolean)
          .join(" · "),
        animate,
      );
    }
    case "notice":
      return metaLine(String(rest.text ?? ""), animate);
    case "code_result": {
      const block = fade(h("article", "tc-msg tc-msg-research"), animate);
      block.append(
        h("p", "tc-msg-label", "Task result"),
        ...markdownBlocks(String(rest.text ?? "")),
      );
      return block;
    }
    case "research_result": {
      const block = fade(h("article", "tc-msg tc-msg-research"), animate);
      block.append(
        h("p", "tc-msg-label", "Research report"),
        ...markdownBlocks(String(rest.text ?? "")),
      );
      return block;
    }
    case "turn_error":
    case "setup_error": {
      const block = fade(h("article", "tc-msg tc-msg-error"), animate);
      block.append(h("p", "tc-para", String(rest.text ?? "Turn failed")));
      if (typeof rest.stderr === "string" && rest.stderr.trim()) {
        block.append(clampable("tc-tool-out", rest.stderr.trim()));
      }
      return block;
    }
    default: {
      // Unknown record types stay visible as the raw fallback.
      const { seq, at, type, ...other } = event;
      const time = at ? new Date(at).toLocaleTimeString() : "";
      const body =
        typeof other.text === "string"
          ? other.text
          : JSON.stringify(other, null, 2);
      return fade(
        h(
          "article",
          "tc-event",
          h("p", "tc-event-meta", `${seq} · ${type} · ${time}`),
          h("pre", "tc-event-body", body),
        ),
        animate,
      );
    }
  }
}

/**
 * Live view of the in-flight turn. Blocks are diffed in place: the block
 * still streaming swaps its content as tokens arrive (no animation restart),
 * and each newly completed block mounts once with the fade — block by block.
 * The thinking indicator renders into `thoughtHost` (pinned above the
 * composer) rather than into the transcript flow.
 */
export class PartialView {
  readonly el = h("div", "tc-partial");
  private thoughtEl: HTMLElement | null = null;
  private thoughtTail: HTMLElement | null = null;
  private toolEl: HTMLElement | null = null;
  private toolWatched = false;
  private textWrap: HTMLElement | null = null;

  constructor(
    private basePath?: string,
    private thoughtHost?: HTMLElement,
  ) {}

  /** The streaming agent-message block, if text is currently streaming. */
  textEl(): HTMLElement | null {
    return this.textWrap;
  }

  /** How many completed blocks are already visible for the streaming text. */
  shownTextBlocks(): number {
    return this.textWrap?.children.length ?? 0;
  }

  /** The in-flight shell/python/edit tool block, if one is running. */
  watchedToolEl(): HTMLElement | null {
    return this.toolWatched ? this.toolEl : null;
  }

  update(partial: TurnPartial | null): void {
    if (partial?.thought) {
      if (!this.thoughtEl) {
        this.thoughtTail = h("span", "tc-thought-tail");
        this.thoughtEl = h(
          "p",
          "tc-thought-live",
          h("span", "tc-thinking-word", "Thinking"),
          this.thoughtTail,
        );
        (this.thoughtHost ?? this.el).append(this.thoughtEl);
      }
      this.thoughtTail!.textContent = lastLine(partial.thought);
    } else if (this.thoughtEl) {
      this.thoughtEl.remove();
      this.thoughtEl = null;
      this.thoughtTail = null;
    }

    if (partial?.tool) {
      const next = toolBlock({
        toolName: partial.tool.toolName,
        command: partial.tool.command,
        output: partial.tool.output,
        status: partial.tool.status ?? "in_progress",
        animate: false,
        basePath: this.basePath,
      });
      if (this.toolEl) this.toolEl.replaceWith(next);
      else this.el.append(next);
      this.toolEl = next;
      this.toolWatched = isWatchedTool(
        partial.tool.toolName,
        undefined,
        partial.tool.command,
      );
    } else if (this.toolEl) {
      this.toolEl.remove();
      this.toolEl = null;
      this.toolWatched = false;
    }

    // Only completed paragraphs render while streaming — each lands whole
    // with its fade; the still-typing tail is withheld until its blank line.
    const doneText = partial?.text ? completedPrefix(partial.text) : "";
    if (doneText) {
      if (!this.textWrap) {
        this.textWrap = h("article", "tc-msg tc-msg-agent");
        this.el.append(this.textWrap);
      }
      const wrap = this.textWrap;
      const next = markdownBlocks(doneText);
      const existing = [...wrap.children] as HTMLElement[];
      next.forEach((block, i) => {
        const cur = existing[i];
        if (!cur) {
          // A newly completed block: mount once, fading in.
          block.classList.add("tc-fade");
          wrap.append(block);
        } else if (cur.tagName !== block.tagName) {
          cur.replaceWith(block);
        } else if (cur.innerHTML !== block.innerHTML) {
          // A block markdown re-shaped (list grew): mutate in place so its
          // fade never restarts.
          cur.innerHTML = block.innerHTML;
        }
      });
      // Markdown can merge blocks as more text arrives (fence backoff).
      for (let i = next.length; i < existing.length; i++) existing[i].remove();
    } else if (!partial?.text && this.textWrap) {
      this.textWrap.remove();
      this.textWrap = null;
    }
  }
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return ` · ${lines[lines.length - 1].slice(-120)}`;
}
