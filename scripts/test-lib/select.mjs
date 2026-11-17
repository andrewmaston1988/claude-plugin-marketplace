// Coverage and diff selection: a file belongs to a suite when its globs expand
// to it, and a changed path is owned by the suite whose plugin or home dir holds
// it. `--all`, `--suite` and a diff all name files through `expandRun`.

import * as nodeFs from "node:fs";
import { join, posix } from "node:path";

import { REPO_SUITE } from "../test-suites.mjs";
import { SKIP_DIRS, closureOf, makeIndex } from "./graph.mjs";

export { SKIP_DIRS };

/** Whole-suite fallbacks: the graph cannot see these files, so any change to
 *  one runs its plugin's suite rather than guessing. */
const FALLBACK_BASENAMES = new Set(["package.json", "package-lock.json", ".env.test"]);

/** The runner decides what every other test does, so a change to it cannot be
 *  scoped: every suite runs. */
const RUNNER_PATHS = new Set(["scripts/test.mjs", "scripts/test-suites.mjs", ".github/workflows/test.yml"]);
const RUNNER_DIR = "scripts/test-lib/";

function isRunnerPath(path) {
  return RUNNER_PATHS.has(path) || path.startsWith(RUNNER_DIR);
}

// --- Glob expansion --------------------------------------------------------

/** `**` matches zero or more directories, `*` never crosses `/`. */
export function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/** The leading path with no wildcard in it. Walking from here rather than from
 *  the run's cwd is what keeps a suite's expansion off the rest of the tree. */
function staticPrefix(pattern) {
  const parts = pattern.split("/");
  const kept = [];
  for (const part of parts) {
    if (/[*?]/.test(part)) break;
    kept.push(part);
  }
  return kept.join("/");
}

/** Every file under `absDir`, repo-relative posix, refusing the directories
 *  `skipDirs` names. The orphan check walks the whole repository with it, so
 *  one walker decides what "a file in this repo" means for both. */
export function walkFrom(absDir, relBase, out, _readdirSync = nodeFs.readdirSync, skipDirs = SKIP_DIRS) {
  let entries;
  try {
    entries = _readdirSync(absDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkFrom(join(absDir, entry.name), rel, out, _readdirSync, skipDirs);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return true;
}

function runCwdRel(run) {
  return run.cwd === "." || run.cwd === "" ? "" : posix.normalize(run.cwd);
}

/** Repo-relative posix paths a run's globs match, sorted. Empty means the run
 *  is misconfigured: `node --test` with no file arguments discovers whatever
 *  happens to sit in its cwd, which is how a suite's own fixtures get executed. */
export function expandRun(run, { repoRoot, _readdirSync = nodeFs.readdirSync } = {}) {
  const cwdAbs = join(repoRoot, run.cwd);
  const matchers = run.globs.map(globToRegExp);
  const exclusions = run.exclude || [];
  const relToCwd = [];
  for (const pattern of run.globs) {
    const prefix = staticPrefix(pattern);
    // A prefix that is not a directory is a literal file path.
    if (!walkFrom(join(cwdAbs, prefix), prefix, relToCwd, _readdirSync) && prefix !== "") {
      relToCwd.push(prefix);
    }
  }
  const cwdRel = runCwdRel(run);
  const found = new Set();
  for (const rel of relToCwd) {
    if (!matchers.some((matcher) => matcher.test(rel))) continue;
    if (exclusions.some((fragment) => rel.includes(fragment))) continue;
    found.add(cwdRel === "" ? rel : posix.join(cwdRel, rel));
  }
  return [...found].sort();
}

// --- Suite shape -----------------------------------------------------------

/** The plugin names a suite's runs cover, read off its globs and cwd. */
export function suitePlugins(suite) {
  const out = new Set();
  for (const run of suite.runs) {
    for (const glob of run.globs) {
      const match = /^plugins\/([^/]+)\//.exec(posix.join(runCwdRel(run) || ".", glob));
      if (match) out.add(match[1]);
    }
  }
  return out;
}

/** The directories outside `plugins/` a suite's runs live in: the glob's static
 *  prefix with its trailing `tests` dropped, so a `bakeoff/.../tests` run owns
 *  its protocol directory. Plugin globs keep the import-closure rule. */
export function suiteHomeDirs(suite) {
  const out = new Set();
  for (const run of suite.runs) {
    for (const glob of run.globs) {
      const parts = posix
        .join(runCwdRel(run) || ".", staticPrefix(glob))
        .replace(/^\.\/?/, "")
        .split("/")
        .filter(Boolean);
      if (parts[parts.length - 1] === "tests") parts.pop();
      if (parts.length === 0) continue;
      if (parts[0] === "plugins" || parts[0] === "scripts" || parts[0] === ".github") continue;
      out.add(parts.join("/"));
    }
  }
  return out;
}

/** The directory a suite's graph may look inside. A plugin suite cannot see a
 *  sibling plugin: two files of the same basename in different plugins must
 *  never be confused for each other. */
export function suiteRoot(suite) {
  const plugins = suitePlugins(suite);
  if (plugins.size === 1) return `plugins/${[...plugins][0]}`;
  const first = suite.runs[0];
  return posix.join(runCwdRel(first) || ".", staticPrefix(first.globs[0])).replace(/^\.\/?/, "");
}

function isFallbackPath(path) {
  const base = posix.basename(path);
  if (FALLBACK_BASENAMES.has(base)) return true;
  if (path.endsWith("/hooks/hooks.json")) return true;
  return path.split("/").some((segment) => segment === ".claude-plugin" || segment === ".codex-plugin");
}

function suiteFiles(suite, repoRoot, _readdirSync) {
  const out = new Set();
  for (const run of suite.runs) for (const file of expandRun(run, { repoRoot, _readdirSync })) out.add(file);
  return [...out].sort();
}

// --- Selection -------------------------------------------------------------

/** Which test files a changed set selects, and why.
 *
 *  `why` is `changed: <path>` for a file the graph reached, `fallback: <path>`
 *  for a whole suite a change could not be attributed to, and `windows` for a
 *  `*.win.test.mjs`, which always runs on a Windows machine. */
export function select({
  suites,
  changed,
  repoRoot,
  _readdirSync = nodeFs.readdirSync,
  _readFileSync = nodeFs.readFileSync,
} = {}) {
  const indexes = new Map();
  const filesCache = new Map();
  const indexFor = (suite) => {
    if (!indexes.has(suite.name)) {
      indexes.set(suite.name, makeIndex({ repoRoot, root: suiteRoot(suite), _readdirSync, _readFileSync }));
    }
    return indexes.get(suite.name);
  };
  const filesFor = (suite) => {
    if (!filesCache.has(suite.name)) filesCache.set(suite.name, suiteFiles(suite, repoRoot, _readdirSync));
    return filesCache.get(suite.name);
  };

  const why = new Map();
  const add = (suite, file, reason) => {
    const key = `${suite.name}\0${file}`;
    if (!why.has(key)) why.set(key, reason);
  };
  const addWhole = (suite, reason) => {
    for (const file of filesFor(suite)) add(suite, file, reason);
  };

  const byPlugin = new Map();
  for (const suite of suites) {
    for (const plugin of suitePlugins(suite)) {
      if (!byPlugin.has(plugin)) byPlugin.set(plugin, []);
      byPlugin.get(plugin).push(suite);
    }
  }
  const byHome = new Map();
  for (const suite of suites) {
    for (const dir of suiteHomeDirs(suite)) {
      if (!byHome.has(dir)) byHome.set(dir, []);
      byHome.get(dir).push(suite);
    }
  }
  const repoSuite = suites.find((suite) => suite.name === REPO_SUITE) || null;

  let attributed = 0;
  for (const path of changed) {
    let selected = false;
    const plugin = /^plugins\/([^/]+)\//.exec(path)?.[1] || null;
    const covering = plugin ? byPlugin.get(plugin) || [] : [];
    const owners = [];
    for (const [dir, owned] of byHome) {
      if (path === dir || path.startsWith(`${dir}/`)) owners.push(...owned);
    }

    if (isRunnerPath(path)) {
      for (const suite of suites) addWhole(suite, `fallback: ${path}`);
      selected = true;
    } else if (path.startsWith("scripts/") || path.startsWith(".github/")) {
      if (repoSuite) {
        addWhole(repoSuite, `fallback: ${path}`);
        selected = true;
      }
    } else if (covering.length > 0) {
      if (isFallbackPath(path)) {
        for (const suite of covering) addWhole(suite, `fallback: ${path}`);
        selected = true;
      } else {
        for (const suite of covering) {
          const index = indexFor(suite);
          for (const file of filesFor(suite)) {
            if (closureOf(file, index).has(path)) {
              add(suite, file, `changed: ${path}`);
              selected = true;
            }
          }
        }
        // A non-Markdown file in no closure is invisible to the graph, so the
        // plugin's whole suite runs. A Markdown file is assumed doc-only.
        if (!selected && !path.endsWith(".md")) {
          for (const suite of covering) addWhole(suite, `fallback: ${path}`);
          selected = true;
        }
      }
    } else if (owners.length > 0) {
      // Outside plugins/ there is no import graph, so a change under a suite's
      // own home runs that suite whole, as an unreached plugin file does.
      if (!path.endsWith(".md")) {
        for (const suite of owners) addWhole(suite, `fallback: ${path}`);
        selected = true;
      }
    } else if (repoSuite && isFallbackPath(path)) {
      addWhole(repoSuite, `fallback: ${path}`);
      selected = true;
    }
    if (selected) attributed += 1;
  }

  for (const suite of suites) {
    for (const file of filesFor(suite)) {
      if (file.endsWith(".win.test.mjs")) add(suite, file, "windows");
    }
  }

  const entries = [];
  for (const suite of suites) {
    for (const file of filesFor(suite)) {
      const reason = why.get(`${suite.name}\0${file}`);
      if (reason) entries.push({ suite: suite.name, file, why: reason });
    }
  }
  return { entries, docsOnly: changed.length > 0 && attributed === 0 };
}

/** Every file of every suite, as `--all` and `--suite` see them. */
export function wholeEntries(suites, { repoRoot, _readdirSync } = {}) {
  const entries = [];
  for (const suite of suites) {
    for (const file of suiteFiles(suite, repoRoot, _readdirSync)) {
      entries.push({ suite: suite.name, file, why: "suite" });
    }
  }
  return entries;
}
