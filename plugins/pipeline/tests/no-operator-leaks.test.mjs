// assert no operator-private values leak in the shipped plugin tree.
//
// A fresh `git clone` of the marketplace must not contain references to the
// plugin author's private machine paths, project names, channels, or preferred
// flags. This test grep-walks the plugin tree for forbidden substrings.
//
// Author metadata in `.claude-plugin/plugin.json` (name/email/repo URL) is
// intentional marketplace manifest content and is excluded.
// `tests/parity-fixtures/` snapshots capture pre-sanitisation state (e.g. the
// dated model ID `-20251001`) for parity-runner correctness and are excluded.
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN = [
  "ai-ops",
  "--deep",
  "-20251001",
  "C:/code/CLAUDE",
  "C:\\code\\CLAUDE",
  "C:/code/claude-plugin",
  "C:\\code\\claude-plugin",
  "repos/CLAUDE/",
  "repos\\CLAUDE\\",
  "claude-wt/",
  "claude-wt\\",
];

const SKIP_DIRS = new Set([
  "tests/parity-fixtures",
  ".claude-plugin",
]);

const SCAN_EXT = /\.(mjs|md|json|js)$/;

function* walk(dir, rel = "") {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(nextRel)) continue;
      yield* walk(join(dir, ent.name), nextRel);
    } else if (ent.isFile() && SCAN_EXT.test(ent.name)) {
      yield { abs: join(dir, ent.name), rel: nextRel };
    }
  }
}

test("no operator-private values in shipped plugin tree", (t) => {
  const leaks = [];
  for (const { abs, rel } of walk(PLUGIN_ROOT)) {
    if (rel === "tests/no-operator-leaks.test.mjs") continue;
    const content = readFileSync(abs, "utf8");
    for (const needle of FORBIDDEN) {
      if (content.includes(needle)) {
        leaks.push(`${rel}: contains ${JSON.stringify(needle)}`);
      }
    }
  }
  if (leaks.length > 0) {
    t.diagnostic(`${leaks.length} leak(s) found:`);
    for (const l of leaks) t.diagnostic(`  ${l}`);
    throw new Error(`Operator-private leak(s) detected — see diagnostics above`);
  }
});
