import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initResultsDir, resultPath, writeResult, readResult, writeSummary,
  writeDigestMd, appendRunLog, formatTokens, renderRoster, renderStatus, formatClosing,
} from "../src/results.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-res-"));
}

test("renderStatus: expand events add forEach clone rows under the parent", () => {
  const dir = tmp();
  try {
    initResultsDir(dir);
    appendRunLog(dir, { ts: "2026-07-11T10:00:00Z", event: "run-start", tasks: [{ id: "src", model: "haiku" }, { id: "fix", model: "haiku" }] });
    appendRunLog(dir, { ts: "2026-07-11T10:00:01Z", id: "src", state: "ok", durationMs: 10 });
    appendRunLog(dir, { ts: "2026-07-11T10:00:02Z", event: "expand", id: "fix", model: "haiku", clones: 2 });
    appendRunLog(dir, { ts: "2026-07-11T10:00:03Z", id: "fix[0]", state: "ok", durationMs: 5 });
    appendRunLog(dir, { ts: "2026-07-11T10:00:04Z", id: "fix[1]", state: "running" });
    const out = renderStatus(dir, Date.parse("2026-07-11T10:00:05Z"));
    ok(out.includes("fix[0]"), out);
    ok(out.includes("fix[1]"), out);
    match(out, /4 tasks/); // 2 declared + 2 clones
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initResultsDir creates results/ and a '*' .gitignore", () => {
  const dir = join(tmp(), "run-1");
  try {
    initResultsDir(dir);
    ok(existsSync(join(dir, "results")));
    equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
    // idempotent, does not clobber an existing .gitignore
    writeFileSync(join(dir, ".gitignore"), "custom\n");
    initResultsDir(dir);
    equal(readFileSync(join(dir, ".gitignore"), "utf8"), "custom\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeResult/readResult round-trip; corrupt file reads as null", () => {
  const dir = tmp();
  try {
    initResultsDir(dir);
    const obj = { id: "a", model: "haiku", ok: true, exit: 0, durationMs: 12, output: "hi" };
    const p = writeResult(dir, "a", obj);
    equal(p, resultPath(dir, "a"));
    deepEqual(readResult(dir, "a"), obj);
    equal(readResult(dir, "missing"), null);
    writeFileSync(resultPath(dir, "bad"), "{corrupt");
    equal(readResult(dir, "bad"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run.log is JSONL, one line per append", () => {
  const dir = tmp();
  try {
    initResultsDir(dir);
    appendRunLog(dir, { id: "a", state: "running" });
    appendRunLog(dir, { id: "a", state: "ok" });
    const lines = readFileSync(join(dir, "run.log"), "utf8").trim().split("\n");
    equal(lines.length, 2);
    deepEqual(lines.map((l) => JSON.parse(l).state), ["running", "ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSummary and writeDigestMd land at contract paths", () => {
  const dir = tmp();
  try {
    initResultsDir(dir);
    const sp = writeSummary(dir, { started: "t0", tasks: [] });
    equal(sp, join(dir, "summary.json"));
    const dp = writeDigestMd(dir, "# Digest");
    equal(dp, join(dir, "digest.md"));
    equal(readFileSync(dp, "utf8"), "# Digest\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatTokens: dash for none, plain under 1k, k and M abbreviations", () => {
  equal(formatTokens(0), "—");
  equal(formatTokens(null), "—");
  equal(formatTokens(982), "982");
  equal(formatTokens(1000), "1k");
  equal(formatTokens(18200), "18.2k");
  equal(formatTokens(100000), "100k");
  equal(formatTokens(1234000), "1.23M");
});

const NOW = Date.parse("2026-07-11T12:04:12Z");

function demoTasks() {
  return [
    { id: "alpha", model: "glm-5.2:cloud", state: "ok", durationMs: 71000, tokens: { input: 10000, output: 8200, cacheCreation: 0, cacheRead: 0 } },
    { id: "beta-long-id", model: "haiku", state: "running", startedMs: NOW - 252000, tokens: { input: 12000, output: 400, cacheCreation: 0, cacheRead: 5000 } },
    { id: "digest", model: "minimax-m3:cloud", state: "pending" },
  ];
}

test("renderRoster: header, aligned rows, counts footer with total tokens", () => {
  const block = renderRoster({ title: "demo-1", tasks: demoTasks(), now: NOW, startedMs: NOW - 252000 });
  const lines = block.split("\n");
  equal(lines[0], "swarm · demo-1 · 3 tasks · 4m12s");
  equal(lines[1], "");
  match(lines[2], /^ {2}✓ {2}alpha\s+glm-5\.2:cloud\s+71s\s+18\.2k$/);
  match(lines[3], /^ {2}◐ {2}beta-long-id\s+haiku\s+252s\s+12\.4k$/);
  match(lines[4], /^ {2}· {2}digest\s+minimax-m3:cloud\s+—\s+—$/);
  // token cells right-align: rows with the same cell widths have equal length
  equal(lines[2].length, lines[3].length);
  equal(lines[5], "");
  equal(lines[6], "  1 ok · 1 running · 1 pending · 30.6k tokens");
});

test("renderRoster: running rows show activity; stale rows warn quiet", () => {
  const tasks = [
    { id: "busy", model: "haiku", state: "running", startedMs: NOW - 10000, activity: "Grep client/scripts/ui", lastEventMs: NOW - 3000 },
    { id: "stuck", model: "haiku", state: "running", startedMs: NOW - 120000, activity: "Read a.gd", lastEventMs: NOW - 95000 },
    { id: "done", model: "haiku", state: "ok", durationMs: 5000, activity: "Bash x" },
  ];
  const block = renderRoster({ title: "t", tasks, now: NOW, startedMs: NOW - 120000, quietWarnMs: 60000 });
  match(block, /◐ {2}busy\s+haiku\s+10s\s+— {2}Grep client\/scripts\/ui$/m);
  match(block, /◐ {2}stuck\s+haiku\s+120s\s+— {2}⚠ quiet 95s$/m);
  match(block, /✓ {2}done\s+haiku\s+5s\s+—$/m); // terminal rows never show activity
});

test("renderRoster: non-ok terminal states carry a state tag; zero tokens omits total", () => {
  const tasks = [
    { id: "a", model: "haiku", state: "failed", durationMs: 1000 },
    { id: "b", model: "haiku", state: "failed:timeout", durationMs: 2000 },
    { id: "c", model: "haiku", state: "rate-limited", durationMs: 500 },
    { id: "d", model: "haiku", state: "blocked" },
    { id: "e", model: "haiku", state: "skipped" },
  ];
  const block = renderRoster({ title: "t", tasks, now: NOW, startedMs: NOW - 5000 });
  match(block, /✗ {2}a .*\[failed\]/);
  match(block, /✗ {2}b .*\[failed:timeout\]/);
  match(block, /⧖ {2}c .*\[rate-limited\]/);
  match(block, /⊘ {2}d .*\[blocked\]/);
  match(block, /↷ {2}e .*\[skipped\]/);
  ok(block.includes("2 failed · 1 rate-limited · 1 blocked · 1 skipped"), block);
  ok(!block.includes("tokens"), "footer must omit tokens when none were counted");
});

test("renderStatus: rebuilds the roster from run.log with live tokens and elapsed", async () => {
  const { renderStatus } = await import("../src/results.mjs");
  const dir = tmp();
  try {
    const rd = join(dir, "demo-2");
    initResultsDir(rd);
    const t0 = new Date(NOW - 42000).toISOString();
    const entries = [
      { ts: t0, event: "run-start", tasks: [{ id: "a", model: "haiku" }, { id: "b", model: "glm-5.2:cloud" }, { id: "c", model: "haiku" }] },
      { ts: t0, id: "a", state: "running" },
      { ts: t0, id: "a", state: "ok", durationMs: 30000, tokens: { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0 } },
      { ts: t0, id: "b", state: "running" },
      { ts: t0, id: "b", event: "tokens", tokens: { input: 7000, output: 300, cacheCreation: 0, cacheRead: 100 } },
      { ts: new Date(NOW - 5000).toISOString(), id: "b", event: "activity", activity: "Grep src/auth" },
    ];
    writeFileSync(join(rd, "run.log"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const out = renderStatus(rd, NOW);
    ok(out.includes(`run: ${rd}`), out);
    match(out, /✓ {2}a\s+haiku\s+30s\s+1\.5k/);
    match(out, /◐ {2}b\s+glm-5\.2:cloud\s+42s\s+7\.3k {2}Grep src\/auth/); // live activity from run.log
    match(out, /· {2}c\s+haiku\s+—\s+—/);
    ok(out.includes("1 ok · 1 running · 1 pending · 8.8k tokens"), out);
    ok(out.includes(`results: ${join(rd, "results")}`), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatus: quietWarnMs is caller-tunable (config-threaded from the CLI)", async () => {
  const { renderStatus } = await import("../src/results.mjs");
  const dir = tmp();
  try {
    const rd = join(dir, "quiet");
    initResultsDir(rd);
    const t0 = new Date(NOW - 30000).toISOString();
    const entries = [
      { ts: t0, event: "run-start", tasks: [{ id: "a", model: "haiku" }] },
      { ts: t0, id: "a", state: "running" },
    ];
    writeFileSync(join(rd, "run.log"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    ok(/⚠ quiet 30s/.test(renderStatus(rd, NOW, 10000)), "10s threshold: 30s silence warns");
    ok(!/⚠ quiet/.test(renderStatus(rd, NOW, 120000)), "120s threshold: 30s silence is fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatus: tolerates legacy run-start with plain id strings", async () => {
  const { renderStatus } = await import("../src/results.mjs");
  const dir = tmp();
  try {
    const rd = join(dir, "legacy");
    initResultsDir(rd);
    const t0 = new Date(NOW - 1000).toISOString();
    const entries = [
      { ts: t0, event: "run-start", tasks: ["a", "b"] },
      { ts: t0, id: "a", state: "ok" },
    ];
    writeFileSync(join(rd, "run.log"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const out = renderStatus(rd, NOW);
    ok(out.includes("1 ok · 1 pending"), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStatus: missing run.log names the ABSOLUTE path it checked", async () => {
  const { renderStatus } = await import("../src/results.mjs");
  const msg = renderStatus("some-relative-dir");
  const { isAbsolute } = await import("node:path");
  const m = msg.match(/no run\.log at (.+?) \(absolute\)/);
  if (!m) throw new Error("message shape changed: " + msg);
  if (!isAbsolute(m[1])) throw new Error("path not absolute: " + m[1]);
});

test("formatClosing covers digest present, absent, failed, and total tokens", () => {
  const base = { summaryPath: "S/summary.json" };
  ok(formatClosing({ ...base, digestPath: "S/digest.md" }).includes("digest: S/digest.md"));
  ok(formatClosing({ ...base }).includes("digest: none"));
  ok(formatClosing({ ...base, digestFailed: true }).includes("FAILED"));
  const withWt = formatClosing({
    ...base, digestPath: "d",
    worktreesKept: [{ id: "impl", branch: "swarm/impl", path: "R/wt-impl" }],
  });
  ok(withWt.includes("worktrees kept:"));
  ok(withWt.includes("impl: swarm/impl at R/wt-impl"));
  ok(formatClosing(base).includes("summary: S/summary.json"));
  const withTok = formatClosing({ ...base, totalTokens: { input: 100000, output: 60200, cacheCreation: 0, cacheRead: 999 } });
  ok(withTok.includes("tokens: 160.2k (input 100k · output 60.2k)"), withTok);
  ok(!formatClosing(base).includes("tokens:"), "no tokens line when nothing counted");
});

test("formatClosing: tokens line carries actual-vs-estimate only when an estimate exists", () => {
  const base = { summaryPath: "S/summary.json", totalTokens: { input: 100000, output: 60200, cacheCreation: 0, cacheRead: 0 } };
  const over = formatClosing({ ...base, estimate: { tokens: 100000, counted: [], unknown: [] } });
  ok(over.includes("estimate was ~100k (60% over)"), over);
  const under = formatClosing({ ...base, estimate: { tokens: 200400, counted: [], unknown: [] } });
  ok(under.includes("estimate was ~200.4k (20% under)"), under);
  const exact = formatClosing({ ...base, estimate: { tokens: 160200, counted: [], unknown: [] } });
  ok(exact.includes("estimate was ~160.2k (on target)"), exact);
  ok(!formatClosing(base).includes("estimate was"), "no comparison without an estimate");
  // estimate but zero actual tokens (e.g. all-compute run): no tokens line, no comparison
  ok(!formatClosing({ summaryPath: "S", estimate: { tokens: 5, counted: [], unknown: [] } }).includes("estimate was"));
});
