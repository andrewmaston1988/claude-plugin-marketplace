// Engine-authored prompt text, appended after the author's own: only a leaf's
// FINAL message is kept, and a codex leaf has a shell rather than Claude tools.
import { codexSandbox } from "./codex.mjs";

const FINAL_MESSAGE =
  "Only your FINAL message is recorded as your result — put every finding in it; nothing said earlier is kept.";

const codexToolLine = (sandbox) =>
  "You have no Read/Grep/Glob/Edit/Write tools here — a shell only. Where this prompt names them, use shell " +
  `commands (type/cat, rg/findstr, sed -n); your sandbox is ${sandbox}.`;

/** The engine's notice block for one leaf: the output contract every runner
 *  gets, plus the codex tool/sandbox line for a codex leaf. */
export function leafNotices({ runner, sandbox } = {}) {
  if (runner !== "codex" || !sandbox) return FINAL_MESSAGE;
  return `${FINAL_MESSAGE}\n${codexToolLine(sandbox)}`;
}

const SEPARATOR = "\n\n";
const ANCHOR = `${SEPARATOR}${FINAL_MESSAGE}`;

// The engine only ever appends its block, so the block is the TAIL: a prompt
// that quotes these words mid-text is the author's, not a previous telling.
function blockAt(text) {
  const at = text.lastIndexOf(ANCHOR);
  if (at === -1) return -1;
  const tail = text.slice(at + ANCHOR.length);
  const sandbox = tail.slice(tail.lastIndexOf(" ") + 1, -1);
  return tail === "" || tail === `\n${codexToolLine(sandbox)}` ? at : -1;
}

/** Append the notice to a leaf's prompt. Idempotent — a prompt that already
 *  ends with the block is returned unchanged, so no leaf is ever told twice. */
export function withLeafNotices(prompt, task, cfg, runner) {
  const text = String(prompt ?? "");
  if (blockAt(text) !== -1) return text;
  return text + SEPARATOR + leafNotices({ runner, sandbox: sandboxFor(task, cfg, runner) });
}

/** The author's prompt, with the engine's block removed. */
export function withoutLeafNotices(prompt) {
  const text = String(prompt ?? "");
  const at = blockAt(text);
  return at === -1 ? text : text.slice(0, at);
}

// The sandbox word is advisory prose: an unusable one is refused by the dispatch
// itself, which must stay the error the operator sees — a throw here would reject
// the whole run in place of failing one leaf.
function sandboxFor(task, cfg, runner) {
  if (runner !== "codex") return undefined;
  try {
    return codexSandbox(task, { config: cfg });
  } catch {
    return undefined;
  }
}
