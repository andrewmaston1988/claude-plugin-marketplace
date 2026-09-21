// 500-line growth ratchet: a file over the bar may not grow.
//
//     over the bar  AND  grew  ->  block
//
// Nothing else. A file under the bar is not this script's business, and
// shrinking is always allowed. Two consequences are deliberate:
//
//   * An oversized file can still be EDITED -- bugfixes do not require a
//     refactor first. Only enlargement is blocked. A ratchet that blocks all
//     work on day one is a ratchet that gets uninstalled.
//   * A file may cross the bar in a single commit (500 -> 501 passes, because
//     it was not over the bar when the commit started) and is locked from the
//     next commit onward. Blocking the crossing would stop someone adding
//     three lines to a 500-line file, which generates override noise for no
//     benefit.
//
// A brand-new file over the bar is a separate violation: it has no baseline to
// grandfather, so the growth test alone would let any new file through at any
// size.
//
// The baseline comes from Git, never from a checked-in table of sizes. A
// file's allowance is simply what it was at the last commit, so there is no
// list to go stale.
//
// Usage:
//     node scripts/check-file-size.mjs                 # the staged set
//     node scripts/check-file-size.mjs --against <ref>  # <ref>..HEAD (CI)
//     node scripts/check-file-size.mjs --all           # inventory the tree
//
// Exit codes:
//     0: no violations
//     1: at least one file over the bar grew, or a new file is over the bar
//     2: the input could not be read (git failed, or a listed blob is missing)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Physical lines. Blank lines and comments count: shaving documentation to
// pass the gate would hide the context cost, not solve it.
export const BAR = 500;

const CODE_SUFFIXES = [".mjs", ".js", ".cjs", ".ts", ".tsx", ".py", ".ps1", ".sh"];

// Code plus agent-facing skill Markdown. Not repository history: plans,
// READMEs, REFERENCE docs, sessions, lockfiles and dependency trees are out.
const SKILL_DOC = /^plugins\/.*\/skills\/.*\.md$/;
const EXCLUDED_SEGMENTS = new Set(["node_modules", "sessions", "vendor", ".git"]);

const HOW_TO_SPLIT = `
  SPLIT IT. Do not delete code or tests to buy room, and do not shave comments
  down to fit -- both leave the file just as unreadable and lose something.

  How:
    1. Find a SEAM, not a line number. Group the top-level exports by what they
       are about and move whole groups. Cutting at line 500 gives you two files
       that are each half a thought.
    2. Move whole functions with their imports. Never split mid-function.
    3. Keep the public surface stable: re-export the moved names from the
       original path so no call site outside the file changes.
    4. Use your editor's edit tool -- do not rewrite the file through a script
       that reads and writes it whole, which normalises line endings and turns
       a 20-line change into an unreviewable whole-file diff.
    5. Run the suite after each move, not at the end.

  Why the bar exists: this codebase is read by agents. Opening a 4,000-line
  module to change three lines spends most of a context window before any work
  starts. A long file is not just untidy here -- it is a running cost.

  Current offenders:  node scripts/check-file-size.mjs --all
`;

export class RatchetError extends Error {}

/** Scope predicate. Used by both enforcement and the inventory, so a report
 *  can never be narrower or wider than the rule it reports on. */
export function inScope(path) {
  const posix = String(path).replace(/\\/g, "/");
  if (posix.split("/").some((seg) => EXCLUDED_SEGMENTS.has(seg))) return false;
  if (posix.endsWith(".md")) return SKILL_DOC.test(posix);
  return CODE_SUFFIXES.some((suffix) => posix.endsWith(suffix));
}

/** Lines as `wc -l` counts them: a trailing newline closes a line rather than
 *  opening an empty one, and CRLF is one break, not two. */
export function lineCount(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** The rule, pure over `[path, oldLines, newLines]`.
 *
 *  A new file has `oldLines = 0`; a deleted file has `newLines = 0`. */
export function violations(rows, bar = BAR) {
  const out = [];
  for (const [path, oldLines, newLines] of rows) {
    if (newLines === 0) continue; // deletion: always an improvement
    if (oldLines === 0) {
      if (newLines > bar) {
        out.push(
          `${path}: new file is ${newLines} lines, over the ${bar}-line bar. ` +
            `Split it before committing.`,
        );
      }
      continue;
    }
    if (oldLines > bar && newLines > oldLines) {
      out.push(`${path}: ${oldLines} -> ${newLines} lines, over the ${bar}-line bar.`);
    }
  }
  return out;
}

function gitCapture(args, cwd, what) {
  const r = spawnSync("git", args, { cwd, encoding: "buffer" });
  if (r.error || r.status !== 0) {
    throw new RatchetError(`${what} (git ${args.join(" ")})`);
  }
  return r.stdout;
}

/** NUL-delimited split. `-z` is what keeps a non-ASCII path verbatim: quoted
 *  and octal-escaped, its name no longer ends in a code suffix and the file
 *  silently drops out of the check. */
function splitZ(buf) {
  const fields = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      fields.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  if (start < buf.length) fields.push(buf.subarray(start).toString("utf8"));
  return fields;
}

/** `{ path, oldPath }` per changed in-scope file.
 *
 *  `-M` so a rename reports where the file came from: a pure move of an
 *  oversized file must not read as new debt, or splitting one -- the thing
 *  this ratchet exists to encourage -- is itself blocked.
 *
 *  A failed listing raises rather than returning nothing: an empty list is a
 *  pass, and "git could not answer" must never be read as one. */
export function nameStatus(refs, cwd) {
  const fields = splitZ(
    gitCapture(
      ["diff", "--name-status", "-z", "-M", "--diff-filter=ACMR", ...refs],
      cwd,
      "the changed-file list",
    ),
  );
  const out = [];
  let i = 0;
  while (i + 1 < fields.length) {
    const status = fields[i];
    const isRename = status.startsWith("R") || status.startsWith("C");
    if (isRename && i + 2 < fields.length) {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      i += 3;
      if (inScope(newPath)) out.push({ path: newPath, oldPath });
    } else {
      const path = fields[i + 1];
      i += 2;
      if (inScope(path)) out.push({ path, oldPath: path });
    }
  }
  return out;
}

/** File content at `ref`, or null when it does not exist there.
 *
 *  `ref === ""` reads the index (`:path`), which is the staged content. Bytes
 *  are captured raw and decoded here so an undecodable byte can never kill
 *  git's pipe reader mid-read -- on Windows that death is silent and reads as
 *  "the file does not exist here". */
export function readBlob(ref, path, cwd) {
  const spec = ref === "" ? `:${path}` : `${ref}:${path}`;
  const r = spawnSync("git", ["show", spec], { cwd, encoding: "buffer" });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString("utf8");
}

/** Triples for `violations()`.
 *
 *  `base = null` reads the index (the pre-commit view); a ref reads
 *  `base..HEAD` (CI's view). Both feed the same rule -- CI must not carry a
 *  second copy of it.
 *
 *  `--diff-filter=ACMR` never lists a deletion, so a listed path whose after
 *  blob cannot be read is an error, never a legitimate 0-line file. */
export function collectRows({ base = null, cwd = process.cwd(), _readBlob = readBlob, _nameStatus = nameStatus } = {}) {
  const staged = base === null;
  const oldRef = staged ? "HEAD" : base;
  const newRef = staged ? "" : "HEAD";
  const rows = [];
  for (const { path, oldPath } of _nameStatus(staged ? ["--cached"] : [base, "HEAD"], cwd)) {
    const before = _readBlob(oldRef, oldPath, cwd);
    const after = _readBlob(newRef, path, cwd);
    if (after === null) throw new RatchetError(`${path}'s ${staged ? "staged" : "committed"} content`);
    rows.push([path, before === null ? 0 : lineCount(before), lineCount(after)]);
  }
  return rows;
}

/** Absolute repository root for `cwd`. Every git call is then made from the
 *  root, because both `git diff` and `git ls-files` narrow themselves to the
 *  launch directory -- a run from a plugin subdirectory would otherwise report
 *  a fraction of the tree and read as clean. */
function repoRoot(cwd) {
  return gitCapture(["rev-parse", "--show-toplevel"], cwd, "the repository root")
    .toString("utf8")
    .trim();
}

/** Every tracked in-scope file currently over the bar, largest first.
 *
 *  Report only -- it never blocks on the grandfathered offenders, which is the
 *  whole point of a ratchet rather than a cap. */
export function inventory(cwd = process.cwd()) {
  const root = repoRoot(cwd);
  const paths = splitZ(gitCapture(["ls-files", "-z"], root, "the tracked-file list")).filter(inScope);
  const over = [];
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch (err) {
      process.stderr.write(`[file-size] could not read ${path} for the inventory: ${err.message}\n`);
      continue;
    }
    const n = lineCount(text);
    if (n > BAR) over.push([n, path]);
  }
  over.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
  for (const [n, path] of over) process.stdout.write(`${String(n).padStart(6)}  ${path}\n`);
  process.stdout.write(`\n${over.length} file(s) over the ${BAR}-line bar.\n`);
  return 0;
}

function failClosed(what) {
  process.stderr.write(
    `[file-size] could not read ${what} -- failing closed rather than passing a check it could not make\n`,
  );
  return 2;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  if (argv.includes("--all")) return inventory(cwd);

  let base = null;
  const idx = argv.indexOf("--against");
  if (idx !== -1) {
    const value = argv[idx + 1];
    // An absent or empty base is a wiring fault, not "nothing to compare":
    // CI must not pass a check it never made.
    if (value === undefined || value === "") return failClosed("the base ref (--against needs a ref)");
    if (/^0+$/.test(value)) {
      // The predecessor of a branch's first push is all zeros. There is
      // genuinely nothing to compare against.
      process.stdout.write("[file-size] no comparable base ref (all-zero predecessor); nothing to compare.\n");
      return 0;
    }
    base = value;
  }

  let found;
  try {
    found = violations(collectRows({ base, cwd: repoRoot(cwd) }));
  } catch (err) {
    if (!(err instanceof RatchetError)) throw err;
    return failClosed(err.message);
  }
  if (found.length === 0) return 0;
  process.stderr.write("[file-size] a file over the bar may not grow:\n\n");
  for (const message of found) process.stderr.write(`  ${message}\n`);
  process.stderr.write(HOW_TO_SPLIT);
  return 1;
}

// `exitCode` rather than `exit()`: stdout/stderr are async pipes on Windows and
// would be truncated mid-write.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
