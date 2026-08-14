import { h } from "./dom";
import type { SessionEvent, TurnPartial } from "../theocode/types";

// Event vocabulary → DOM. Design choices:
// - tool calls show the full bash command in mono, clipped to 5 lines
//   (click toggles the clip); output gets the same treatment, dimmer.
// - agent prose fades in paragraph by paragraph as it arrives; historical
//   transcript loads render without animation.

const CLAMP_LINES = 5;

function fade(el: HTMLElement, animate: boolean): HTMLElement {
  if (animate) el.classList.add("tc-fade");
  return el;
}

function clampable(className: string, text: string): HTMLElement {
  const el = h("pre", `${className} tc-clamp`, text);
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

/** Minimal rich text: ``` fences → pre blocks, blank lines → paragraphs,
 *  backticks → inline code. Each paragraph is its own element so streaming
 *  can fade them in one by one. */
export function richParagraphs(text: string, animate: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  const segments = text.split(/```/);
  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      // Fenced code: drop a leading language tag line.
      const body = segment.replace(/^[a-zA-Z0-9_-]*\n/, "").trimEnd();
      if (body) {
        const pre = fade(h("pre", "tc-code"), animate);
        pre.textContent = body;
        out.push(pre);
      }
      return;
    }
    for (const para of segment.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = fade(h("p", "tc-para"), animate);
      for (const [j, piece] of para.split("`").entries()) {
        if (!piece) continue;
        p.append(j % 2 === 1 ? h("code", "tc-inline-code", piece) : piece);
      }
      out.push(p);
    }
  });
  return out;
}

function toolBlock(
  toolName: string,
  command: string | undefined,
  input: unknown,
  output: string | undefined,
  status: string | undefined,
  exitCode: number | undefined,
  animate: boolean,
): HTMLElement {
  const statusText =
    status === "completed"
      ? typeof exitCode === "number" && exitCode !== 0
        ? `exit ${exitCode}`
        : ""
      : status === "failed"
        ? "failed"
        : "running…";
  const head = h(
    "p",
    "tc-tool-head",
    h("span", "tc-tool-name", toolName),
    ...(statusText
      ? [h("span", `tc-tool-status${status === "failed" || exitCode ? " tc-tool-bad" : ""}`, statusText)]
      : []),
  );
  const block = fade(h("article", "tc-tool", head), animate);
  if (command) {
    block.append(clampable("tc-tool-cmd", command));
  } else if (input && Object.keys(input as object).length > 0) {
    block.append(clampable("tc-tool-cmd", JSON.stringify(input, null, 2)));
  }
  if (output?.trim()) block.append(clampable("tc-tool-out", output.trimEnd()));
  return block;
}

function metaLine(text: string, animate: boolean): HTMLElement {
  return fade(h("p", "tc-turn-meta", text), animate);
}

export function eventBlock(event: SessionEvent, animate: boolean): HTMLElement {
  const rest = event as Record<string, unknown>;
  switch (event.type) {
    case "user_message": {
      const block = fade(h("article", "tc-msg tc-msg-user"), animate);
      block.append(
        h("p", "tc-msg-label", "You"),
        ...richParagraphs(String(rest.text ?? ""), false),
      );
      return block;
    }
    case "agent_message": {
      const block = fade(h("article", "tc-msg tc-msg-agent"), false);
      block.append(...richParagraphs(String(rest.text ?? ""), animate));
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
      return toolBlock(
        String(rest.toolName ?? "tool"),
        typeof rest.command === "string" ? rest.command : undefined,
        rest.input,
        typeof rest.output === "string" ? rest.output : undefined,
        typeof rest.status === "string" ? rest.status : undefined,
        typeof rest.exitCode === "number" ? rest.exitCode : undefined,
        animate,
      );
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
    case "research_result": {
      const block = fade(h("article", "tc-msg tc-msg-research"), animate);
      block.append(
        h("p", "tc-msg-label", "Research report"),
        ...richParagraphs(String(rest.text ?? ""), false),
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
 * Live view of the in-flight turn. Children are mutated in place (never
 * re-inserted, which would restart CSS animations): the paragraph still
 * streaming updates its text as tokens arrive, and each newly completed
 * paragraph mounts once with the fade — paragraph by paragraph.
 */
export class PartialView {
  readonly el = h("div", "tc-partial");
  private thoughtEl: HTMLElement | null = null;
  private toolEl: HTMLElement | null = null;
  private textWrap: HTMLElement | null = null;

  update(partial: TurnPartial | null): void {
    if (partial?.thought) {
      if (!this.thoughtEl) {
        this.thoughtEl = h("p", "tc-thought-live");
        this.el.append(this.thoughtEl);
      }
      this.thoughtEl.textContent = `Thinking · ${lastLine(partial.thought)}`;
    } else if (this.thoughtEl) {
      this.thoughtEl.remove();
      this.thoughtEl = null;
    }

    if (partial?.tool) {
      const next = toolBlock(
        partial.tool.toolName,
        partial.tool.command,
        undefined,
        partial.tool.output,
        partial.tool.status ?? "in_progress",
        undefined,
        false,
      );
      if (this.toolEl) this.toolEl.replaceWith(next);
      else this.el.append(next);
      this.toolEl = next;
    } else if (this.toolEl) {
      this.toolEl.remove();
      this.toolEl = null;
    }

    if (partial?.text) {
      const paras = partial.text.split(/\n{2,}/).filter((p) => p.trim());
      if (!this.textWrap) {
        this.textWrap = h("article", "tc-msg tc-msg-agent");
        this.el.append(this.textWrap);
      }
      const wrap = this.textWrap;
      const existing = wrap.querySelectorAll<HTMLElement>(".tc-para");
      paras.slice(0, existing.length).forEach((text, i) => {
        if (existing[i].textContent !== text) existing[i].textContent = text;
      });
      for (const text of paras.slice(existing.length)) {
        wrap.append(h("p", "tc-para tc-fade", text));
      }
    } else if (this.textWrap) {
      this.textWrap.remove();
      this.textWrap = null;
    }
  }
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1].slice(-120);
}
