// One-off builder for the committed coverage fixtures, from real stage4 review transcripts:
// `node plugins/swarm/tests/fixtures/coverage/reduce.mjs`. Keeps tool_use blocks and each
// tool_result's id/is_error (the pairing parseReadCalls needs); empties all text.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = "C:/Users/Andrew/.swarm/runs/C--code-claude-plugin-marketplace/stage4-review-1";
const REPO = "C:/code/claude-plugin-marketplace";
const REVIEW_CWD = "C:\\code\\claude-plugin-marketplace";
const PRINCIPLES_DIR = "C:/code/claude/skills/code-review";

function reduceLeaf(id) {
  const txt = readFileSync(join(RUN, "results", `${id}.log`), "utf8");
  const out = [];
  for (const raw of txt.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith("{")) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (e.type === "assistant") {
      const content = (e.message?.content || []).map((b) =>
        b?.type === "text" ? { type: "text", text: "" } : b);
      out.push({ type: "assistant", message: { ...e.message, content } });
    } else if (e.type === "user") {
      const results = (e.message?.content || []).filter((b) => b?.type === "tool_result");
      if (!results.length) continue;
      out.push({
        type: "user",
        message: {
          content: results.map((b) => ({
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            ...(b.is_error !== undefined && { is_error: b.is_error }),
            content: "",
          })),
        },
      });
    }
  }
  writeFileSync(join(HERE, `${id}.assistant.jsonl`), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return out.length;
}

function lineCountAt(commit, path) {
  const buf = execFileSync("git", ["-C", REPO, "show", `${commit}:${path}`]);
  const s = buf.toString("utf8");
  const lines = s.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function pageEntry(absPath, n, page = 1000) {
  if (n <= page) return { path: absPath, lines: [[1, n]] };
  const ranges = [];
  for (let a = 1; a <= n; a += page) ranges.push([a, Math.min(a + page - 1, n)]);
  return { path: absPath, lines: ranges };
}

function buildIndex() {
  // The changed-file scope the leaves actually reviewed, read from the run's
  // pre-flight (base commit + changed list). Absolute paths under the review cwd
  // (an index expanded across leaves' cwds must be absolute).
  const preflight = {
    scope: "d97a3f1",
    changed: [
      "plugins/swarm/src/ask.mjs",
      "plugins/swarm/src/dispatch.mjs",
      "plugins/swarm/src/results.mjs",
      "plugins/swarm/src/runlog.mjs",
      "plugins/swarm/src/scheduler.mjs",
      "plugins/swarm/src/stream.mjs",
      "plugins/swarm/tests/scheduler.test.mjs",
    ],
  };
  const entries = preflight.changed.map((rel) => {
    const abs = `${REVIEW_CWD}\\${rel.replace(/\//g, "\\")}`;
    return pageEntry(abs, lineCountAt(preflight.scope, rel));
  });
  // The maintainability lens's two principle files — absolute, outside the repo.
  for (const f of ["principles_cross_cutting.md", "principles_maintainability.md"]) {
    const abs = join(PRINCIPLES_DIR, f).replace(/\//g, "\\");
    const n = existsSync(join(PRINCIPLES_DIR, f))
      ? readFileSync(join(PRINCIPLES_DIR, f), "utf8").split(/\r?\n/).filter((_, i, a) => !(i === a.length - 1 && a[i] === "")).length
      : 400;
    entries.push(pageEntry(abs, n));
  }
  writeFileSync(join(HERE, "stage4-index.json"), JSON.stringify({ entries }, null, 2) + "\n");
  return entries.length;
}

console.log("rv-maintainability:", reduceLeaf("rv-maintainability"), "events");
console.log("rv-architecture:", reduceLeaf("rv-architecture"), "events");
console.log("stage4-index.json:", buildIndex(), "entries");
