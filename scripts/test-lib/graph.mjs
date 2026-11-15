// The import graph a diff-aware run selects on: a test is selected when a
// changed file is reachable from it. Reachability is four kinds of edge,
// followed from every file in the closure and not only from the test, because
// the file that names a path is as often a module as a test.
//
//   * relative static imports and `export ... from`;
//   * string-literal `import()`;
//   * `new URL("<rel>", import.meta.url)` literals, with a directory literal
//     adding every file under it;
//   * basename literals -- a string equal to a file name in the same plugin, or
//     ending in `/<name>` -- which is what catches computed paths such as
//     `join(here, "..", "bin", "cli.mjs")`.
//
// Over-selection is the accepted cost: a selected test costs seconds, a missed
// one costs a red PR. Anything the graph cannot see at all falls back to the
// whole suite in the runner.

import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "sessions"]);

// `import x from "…"`, `import { a } from "…"`, `import "…"`. The optional
// middle group excludes parens so a dynamic `import("…")` is left to its own
// rule rather than captured with a garbage specifier.
const STATIC_IMPORT = /\bimport\s+(?:[^"'`()]*?\bfrom\s+)?["']([^"'\n]+)["']/g;
const EXPORT_FROM = /\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const URL_LITERAL = /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g;
const ANY_LITERAL = /["']([^"'\n]+)["']/g;

const MODULE_SUFFIXES = [".mjs", ".js", ".json", "/index.mjs", "/index.js"];

function walk(rel, out, repoRoot, _readdirSync) {
  let entries;
  try {
    entries = _readdirSync(join(repoRoot, rel), { withFileTypes: true });
  } catch {
    return; // a root that does not exist is an empty index, not an error
  }
  for (const entry of entries) {
    const child = rel === "" ? entry.name : posix.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(child, out, repoRoot, _readdirSync);
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
}

/** Every file under `root`, plus the lookup tables the walker needs.
 *
 *  `root` is repo-relative posix ("" is the repo root); the walk never leaves
 *  it, so a plugin suite's basename matching cannot be pulled sideways into a
 *  sibling plugin's file of the same name. */
export function makeIndex({
  repoRoot,
  root = "",
  _readdirSync = readdirSync,
  _readFileSync = readFileSync,
} = {}) {
  const files = [];
  walk(root, files, repoRoot, _readdirSync);
  files.sort();
  const byBasename = new Map();
  for (const file of files) {
    const base = posix.basename(file);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(file);
  }
  return {
    repoRoot,
    root,
    files,
    fileSet: new Set(files),
    byBasename,
    memo: new Map(),
    texts: new Map(),
    _readFileSync,
    /** File text, or null when it cannot be read. Cached: one closure per test
     *  file over the same module is the normal shape. */
    read(file) {
      if (this.texts.has(file)) return this.texts.get(file);
      let text = null;
      try {
        text = this._readFileSync(join(repoRoot, file), "utf8");
      } catch {
        text = null;
      }
      this.texts.set(file, text);
      return text;
    },
  };
}

/** Relative specifiers resolved against the importing file, extensionless ones
 *  tried with the suffixes ESM and Node resolution would add. */
function resolveModule(spec, fromFile, index) {
  if (!spec.startsWith(".")) return [];
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const candidate of [base, ...MODULE_SUFFIXES.map((suffix) => base + suffix)]) {
    if (index.fileSet.has(candidate)) return [candidate];
  }
  return [];
}

/** A `new URL("<rel>", import.meta.url)` literal: a file, or a directory whose
 *  every file is named (`new URL("../templates", …)`). */
function resolveUrlLiteral(literal, fromFile, index) {
  const clean = literal.split("?")[0].split("#")[0];
  const out = resolveModule(clean, fromFile, index);
  const base = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  const prefix = base === "." || base === "" ? null : `${base}/`;
  if (prefix === null) return out;
  for (const file of index.files) {
    if (file.startsWith(prefix)) out.push(file);
  }
  return out;
}

/** Bare or path-shaped string literals that name an existing file. */
function basenameEdges(text, index) {
  const out = [];
  ANY_LITERAL.lastIndex = 0;
  let match;
  while ((match = ANY_LITERAL.exec(text)) !== null) {
    const literal = match[1];
    if (literal.length > 200 || /\s/.test(literal)) continue;
    const normalised = literal.replace(/\\/g, "/").replace(/^\.\//, "");
    const base = posix.basename(normalised);
    if (base === "" || base === "." || base === "..") continue;
    const hits = index.byBasename.get(base);
    if (!hits) continue;
    // Either the literal IS the file name, or it ends in `/<that name>`.
    if (normalised !== base && !normalised.includes("/")) continue;
    for (const file of hits) out.push(file);
  }
  return out;
}

/** Every file one file names, by any of the four edge kinds. */
export function edgesOf(file, text, index) {
  const out = new Set();
  for (const [pattern, resolve] of [
    [STATIC_IMPORT, (spec) => resolveModule(spec, file, index)],
    [EXPORT_FROM, (spec) => resolveModule(spec, file, index)],
    [DYNAMIC_IMPORT, (spec) => resolveModule(spec, file, index)],
    [URL_LITERAL, (literal) => resolveUrlLiteral(literal, file, index)],
  ]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      for (const target of resolve(match[1])) out.add(target);
    }
  }
  for (const target of basenameEdges(text, index)) out.add(target);
  out.delete(file);
  return out;
}

/** Every file reachable from `file`, itself included. Memoised per file and
 *  cycle-safe, so a graph of modules importing each other costs one walk. */
export function closureOf(file, index) {
  const cached = index.memo.get(file);
  if (cached) return cached;
  const seen = new Set();
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const text = index.read(current);
    if (text === null) continue;
    for (const next of edgesOf(current, text, index)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  index.memo.set(file, seen);
  return seen;
}
