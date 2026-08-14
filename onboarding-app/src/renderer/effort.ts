import { button, h } from "./dom";
import {
  REASONING_EFFORTS,
  reasoningEffortInfo,
  resolveReasoningEffort,
  type ReasoningEffort,
} from "../theocode/reasoning";
import type { SessionMeta } from "../theocode/types";

export interface EffortControl {
  trigger: HTMLButtonElement;
  layer: HTMLElement;
  isOpen: () => boolean;
  close: (opts?: { restoreFocus?: boolean }) => void;
  destroy: () => void;
}

/**
 * Header trigger + right-hand slide-out for the session's speed-vs-reasoning
 * setting. Choosing a level persists immediately; it applies to the next turn.
 */
export function mountEffortControl(opts: {
  session: SessionMeta | undefined;
  onChange: (effort: ReasoningEffort) => Promise<void>;
}): EffortControl {
  let current = resolveReasoningEffort(opts.session?.reasoningEffort);
  let open = false;

  const valueEl = h("span", "tc-effort-trigger-value", labelFor(current));
  const trigger = button("tc-effort-trigger", "", () => {
    if (open) close();
    else show();
  });
  trigger.append(
    h("span", "tc-effort-trigger-kicker", "Reasoning vs speed"),
    valueEl,
  );
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "tc-effort-drawer");

  const closeBtn = button("tc-quiet-button", "Close", () => close());
  closeBtn.setAttribute("aria-label", "Close reasoning versus speed");

  const options = REASONING_EFFORTS.map((level) => {
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "tc-reasoning-effort";
    input.value = level.id;
    input.id = `tc-effort-${level.id}`;
    input.checked = level.id === current;
    input.addEventListener("change", () => {
      if (input.checked) void pick(level.id);
    });

    const row = h("label", "tc-effort-option") as HTMLLabelElement;
    row.htmlFor = input.id;
    row.append(
      input,
      h(
        "span",
        "tc-effort-option-copy",
        h("span", "tc-effort-option-label", level.label),
        h("span", "tc-effort-option-detail", level.detail),
      ),
    );
    return { level, input, row };
  });

  const scale = h("fieldset", "tc-effort-scale");
  scale.append(
    h("legend", "vbg-visually-hidden", "Reasoning versus speed"),
    h("p", "tc-effort-pole", "Speed"),
    ...options.map((o) => o.row),
    h("p", "tc-effort-pole", "Reasoning"),
  );

  const drawer = h(
    "aside",
    "tc-effort-drawer",
    h(
      "header",
      "tc-effort-drawer-head",
      h("h2", "tc-effort-title", "Reasoning vs speed"),
      closeBtn,
    ),
    h(
      "p",
      "tc-effort-lede",
      "How much the agent thinks before it acts. Applies to the next turn in this session.",
    ),
    scale,
  );
  drawer.id = "tc-effort-drawer";
  drawer.tabIndex = -1;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-labelledby", "tc-effort-heading");
  drawer.querySelector(".tc-effort-title")!.id = "tc-effort-heading";

  const scrim = h("div", "tc-effort-scrim");
  scrim.addEventListener("click", () => close());

  const layer = h("div", "tc-effort-layer", scrim, drawer);
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;

  function paint(): void {
    const info = reasoningEffortInfo(current);
    valueEl.textContent = info.label;
    for (const option of options) {
      option.input.checked = option.level.id === current;
    }
  }

  async function pick(effort: ReasoningEffort): Promise<void> {
    if (effort === current) return;
    const previous = current;
    current = effort;
    paint();
    try {
      await opts.onChange(effort);
    } catch {
      if (current === effort) {
        current = previous;
        paint();
      }
    }
  }

  function show(): void {
    if (open) return;
    open = true;
    layer.classList.add("is-open");
    layer.inert = false;
    layer.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    drawer.focus();
  }

  function close(args?: { restoreFocus?: boolean }): void {
    if (!open) return;
    open = false;
    layer.classList.remove("is-open");
    layer.inert = true;
    layer.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    if (args?.restoreFocus !== false) trigger.focus();
  }

  function onLayerKey(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === "Tab") trapFocus(event, drawer);
  }
  layer.addEventListener("keydown", onLayerKey);

  return {
    trigger,
    layer,
    isOpen: () => open,
    close,
    destroy: () => {
      close({ restoreFocus: false });
      layer.removeEventListener("keydown", onLayerKey);
    },
  };
}

function labelFor(effort: ReasoningEffort): string {
  return reasoningEffortInfo(effort).label;
}

function trapFocus(event: KeyboardEvent, root: HTMLElement): void {
  const nodes = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ];
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
