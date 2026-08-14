/** Tiny DOM helper: h("p", "vbg-meta", "text") or h("div", "cls", ...children). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Array<string | Node>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.append(...children);
  return el;
}

export function button(
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const el = h("button", className, label);
  el.type = "button";
  el.addEventListener("click", onClick);
  return el;
}
