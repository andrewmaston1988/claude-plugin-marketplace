// Engine-authored prompt text, appended after the author's own: only a leaf's
// FINAL message is kept, and a codex leaf has a shell rather than Claude tools.
import { codexSandbox } from "./codex.mjs";

const FINAL_MESSAGE =
  "Only your FINAL message is recorded as your result — put every finding in it; nothing said earlier is kept.";

// Codex's Windows sandbox denies the named shared-memory section MSYS2's runtime
// creates, so Git's bash/sed/cat/grep die at startup (Win32 error 5) while
// PowerShell and rg run. The host that runs codex is the one that decides.
const PLATFORMS = ["win32", "linux"];

const codexToolLine = (sandbox, platform = process.platform) =>
  platform === "win32"
    ? "You have no Read/Grep/Glob/Edit/Write tools here — a shell only. Where this prompt names them, use PowerShell " +
      `(Get-Content, rg, findstr) — Git's bash, sed, cat and grep cannot start in the codex sandbox; your sandbox is ${sandbox}.`
    : "You have no Read/Grep/Glob/Edit/Write tools here — a shell only. Where this prompt names them, use shell " +
      `commands (type/cat, rg/findstr, sed -n); your sandbox is ${sandbox}.`;

// A codex leaf batches its first command past the model-visible cap and never sees
// the files it was told to read, so the engine writes the read plan to part files and
// names them here: one command per call, from the first turn.
const READS_LINE_HEAD =
  "Your required reads are listed in the files below — run every command in them, one command per call, before you answer:";
const READS_TRUNCATED =
  "  - …additional read-plan parts are omitted from this notice.";
// The ceiling the dispatch budget measures against. A notice longer than the measured
// worst case is a command line validate never vouched for, so a launch may not exceed it.
export const READS_PART_CEILING = 12;

function readsLines(readFiles, omittedReadParts = 0) {
  if (!readFiles?.length) return "";
  const named = readFiles.slice(0, READS_PART_CEILING);
  const block = [READS_LINE_HEAD, ...named.map((p) => `  - ${p}`)];
  if (omittedReadParts > 0 || readFiles.length > named.length) block.push(READS_TRUNCATED);
  return block.join("\n");
}

/** The engine's notice block for one leaf: the output contract every runner
 *  gets, the codex tool/sandbox line, and — for a codex leaf handed one — the
 *  part files holding its read plan. */
export function leafNotices({ runner, sandbox, platform = process.platform, readFiles, omittedReadParts } = {}) {
  if (runner !== "codex") return FINAL_MESSAGE;
  // The reads line is not the sandbox line's business: an unusable sandbox loses the
  // advisory prose, never the list of files the leaf must run.
  return [FINAL_MESSAGE, sandbox && codexToolLine(sandbox, platform), readsLines(readFiles, omittedReadParts)]
    .filter(Boolean).join("\n");
}

const SEPARATOR = "\n\n";
const ANCHOR = `${SEPARATOR}${FINAL_MESSAGE}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A reads block at the very tail: its head line, then one "  - <path>" per part.
const READS_SUFFIX_RE = new RegExp(`\\n${escapeRe(READS_LINE_HEAD)}(?:\\n  - [^\\n]+)*$`);

// The engine only ever appends its block, so the block is the TAIL: a prompt
// that quotes these words mid-text is the author's, not a previous telling.
// Both platforms' tool lines read as the engine's, so a block written on one
// still strips on the other; a reads block rides after the tool line, and its
// paths are the ones the launch wrote, so only its SHAPE can be matched.
function blockAt(text) {
  const at = text.lastIndexOf(ANCHOR);
  if (at === -1) return -1;
  const tail = text.slice(at + ANCHOR.length);
  if (tail === "") return at;
  const reads = READS_SUFFIX_RE.exec(tail);
  const rest = reads === null ? tail : tail.slice(0, reads.index);
  // An unusable sandbox drops the tool line, not the read list: that block is head + reads alone.
  if (reads !== null && rest === "") return at;
  const sandbox = (/your sandbox is (\S+)\.$/.exec(rest) || [])[1];
  if (sandbox === undefined) return -1;
  return PLATFORMS.some((p) => rest === `\n${codexToolLine(sandbox, p)}`) ? at : -1;
}

/** Append the notice to a leaf's prompt. Idempotent — a prompt that already
 *  ends with the block is returned unchanged, so no leaf is ever told twice. */
export function withLeafNotices(prompt, task, cfg, runner, readFiles, omittedReadParts = 0) {
  const text = String(prompt ?? "");
  if (blockAt(text) !== -1) return text;
  return text + SEPARATOR + leafNotices({ runner, sandbox: sandboxFor(task, cfg, runner), readFiles, omittedReadParts });
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
