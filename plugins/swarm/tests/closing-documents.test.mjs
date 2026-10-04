import { test } from "node:test";
import { ok } from "node:assert/strict";
import { formatClosing } from "../src/results.mjs";

// The closing block's document lines (report, pages) and its kept-worktree lines.

// You ask for a report, the leaf doesn't write one, and the closing block says
// NOTHING. That is how you go looking for a report and find silence.
test("formatClosing: a requested report that never landed is LOUD, not absent", () => {
  const out = formatClosing({
    digestPath: "d.md", reportMissing: true, summaryPath: "s.json", totalTokens: null,
  });
  ok(/NOT WRITTEN/.test(out), out);
  ok(/requested/i.test(out), "must say it was asked for");

  // and when it did land, the path — never both
  const ok2 = formatClosing({
    digestPath: "d.md", reportPath: "r.md", summaryPath: "s.json", totalTokens: null,
  });
  ok(ok2.includes("r.md"), ok2);
  ok(!/NOT WRITTEN/.test(ok2), ok2);

  // no report asked for → no report line at all
  const none = formatClosing({ digestPath: "d.md", summaryPath: "s.json", totalTokens: null });
  ok(!/report:/.test(none), none);
});

test("formatClosing: pages that failed to render say so; rendered pages print nothing extra", () => {
  const out = formatClosing({ digestPath: "d.md", summaryPath: "s.json", totalTokens: null, pagesError: "could not render x: boom" });
  ok(/pages:.*NOT RENDERED.*boom/.test(out), out);
  const fine = formatClosing({ digestPath: "d.md", summaryPath: "s.json", totalTokens: null });
  ok(!/pages:/.test(fine), fine);
});

test("formatClosing names every link of a shared chain, and only a chain", () => {
  const chained = formatClosing({ worktreesKept: [
    { name: "feat", branch: "swarm/feat", path: "/w/wt-feat", taskIds: ["p1", "rev", "p2"] },
  ] });
  ok(chained.includes("p1 → rev → p2"), chained);
  ok(chained.includes("feat"), chained);

  // A private tree is a group of one — no arrows, nothing to disambiguate.
  const solo = formatClosing({ worktreesKept: [
    { name: "scan-a", branch: "swarm/scan-a", path: "/w/wt-scan-a", taskIds: ["scan-a"] },
  ] });
  ok(!solo.includes("→"), solo);
});

test("formatClosing prints the prune hint once worktrees are kept and resultsDir/engine are known", () => {
  const withHint = formatClosing({
    summaryPath: "S/summary.json",
    worktreesKept: [{ name: "impl", branch: "swarm/impl", path: "R/wt-impl" }],
    resultsDir: "R",
    engine: "E/swarm.mjs",
  });
  ok(withHint.includes("prune when done: node E/swarm.mjs prune R"), withHint);

  // no resultsDir/engine (older call sites, e.g. cmdStop) — no hint, no crash
  const noHint = formatClosing({
    summaryPath: "S/summary.json",
    worktreesKept: [{ name: "impl", branch: "swarm/impl", path: "R/wt-impl" }],
  });
  ok(!noHint.includes("prune when done"), noHint);

  // no worktrees kept — no hint even with resultsDir/engine present
  const nothingKept = formatClosing({ summaryPath: "S/summary.json", resultsDir: "R", engine: "E/swarm.mjs" });
  ok(!nothingKept.includes("prune when done"), nothingKept);
});
