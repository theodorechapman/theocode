// Lightweight bash tokenizer for transcript command blocks. Good-enough
// coloring, not a shell parser: comments, strings, variables, operators,
// flags, keywords, and the word in command position.

const KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "function", "in", "select", "time", "export", "local",
  "return", "exit", "source",
]);

// Keywords after which the next word is still a command.
const KEEPS_COMMAND_POSITION = new Set([
  "if", "then", "else", "elif", "while", "until", "do", "time", "sudo",
]);

const TOKEN = new RegExp(
  [
    "(#[^\\n]*)", // 1 comment
    "('(?:[^'\\\\]|\\\\.)*'?|\"(?:[^\"\\\\]|\\\\.)*\"?)", // 2 string
    "(\\$\\{[^}]*\\}|\\$\\w+|\\$\\()", // 3 variable / subshell open
    "(\\|\\||&&|[|;&]|\\d?>>?|<|=)", // 4 operator
    "(\\n)", // 5 newline
    "(\\s+)", // 6 space
    "([^\\s'\"#|;&<>=$]+)", // 7 word
  ].join("|"),
  "g",
);

export function highlightBash(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const push = (cls: string | null, text: string) => {
    if (!text) return;
    if (!cls) {
      frag.append(text);
      return;
    }
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    frag.append(span);
  };

  let commandNext = true;
  for (const m of src.matchAll(TOKEN)) {
    const [, comment, str, variable, op, newline, space, word] = m;
    if (comment !== undefined) {
      push("tc-sh-comment", comment);
    } else if (str !== undefined) {
      push("tc-sh-str", str);
    } else if (variable !== undefined) {
      push("tc-sh-var", variable);
      if (variable === "$(") commandNext = true;
    } else if (op !== undefined) {
      push("tc-sh-op", op);
      if (op !== "=" && op !== "<") commandNext = true;
    } else if (newline !== undefined) {
      push(null, newline);
      commandNext = true;
    } else if (space !== undefined) {
      push(null, space);
    } else if (word !== undefined) {
      if (word.startsWith("-")) {
        push("tc-sh-flag", word);
      } else if (KEYWORDS.has(word)) {
        push("tc-sh-kw", word);
        commandNext = KEEPS_COMMAND_POSITION.has(word);
      } else if (commandNext) {
        push("tc-sh-cmd", word);
        commandNext = KEEPS_COMMAND_POSITION.has(word);
      } else {
        push(null, word);
      }
    }
  }
  return frag;
}
