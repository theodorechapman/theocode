import { Marked } from "marked";
import { highlightBash } from "./bash";

// Full GitHub-flavored markdown for agent prose. Raw HTML in the source is
// escaped rather than injected — agent output is not trusted as markup.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const md = new Marked({ gfm: true });
md.use({
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
  },
});

/**
 * Render markdown into one element per top-level block, so streaming can
 * fade blocks in one by one. Fenced bash/sh code gets syntax colors.
 */
export function markdownBlocks(text: string): HTMLElement[] {
  const host = document.createElement("div");
  host.innerHTML = md.parse(text, { async: false });
  for (const a of host.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noreferrer";
  }
  for (const code of host.querySelectorAll<HTMLElement>("pre > code")) {
    if (/\blanguage-(bash|sh|shell|zsh)\b/.test(code.className)) {
      const colored = highlightBash(code.textContent ?? "");
      code.replaceChildren(colored);
    }
  }
  const blocks = [...host.children] as HTMLElement[];
  for (const block of blocks) block.classList.add("tc-md");
  return blocks;
}
