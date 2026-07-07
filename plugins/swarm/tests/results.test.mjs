import { test } from "node:test";
import { equal, deepEqual, ok, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initResultsDir, resultPath, writeResult, readResult, writeSummary,
  writeDigestMd, appendRunLog, formatStatusLine, formatClosing,
} from "../src/results.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-res-"));
}

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

test("formatStatusLine matches the contract shape", () => {
  equal(formatStatusLine({ id: "scan-a", model: "glm-4.6:cloud", state: "ok", durationMs: 42000 }), "✓ scan-a glm-4.6:cloud 42s");
  match(formatStatusLine({ id: "x", model: "haiku", state: "failed", durationMs: 1000 }), /^✗ x haiku 1s \[failed\]$/);
  match(formatStatusLine({ id: "x", model: "haiku", state: "rate-limited", durationMs: 500 }), /\[rate-limited\]$/);
  match(formatStatusLine({ id: "x", model: "haiku", state: "blocked" }), /^⊘ x haiku \[blocked\]$/);
  match(formatStatusLine({ id: "x", model: "haiku", state: "skipped" }), /\[skipped\]$/);
});

test("formatClosing covers digest present, absent, and failed", () => {
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
});

test("renderStatus: missing run.log names the ABSOLUTE path it checked", async () => {
  const { renderStatus } = await import("../src/results.mjs");
  const msg = renderStatus("some-relative-dir");
  const { isAbsolute } = await import("node:path");
  const m = msg.match(/no run\.log at (.+?) \(absolute\)/);
  if (!m) throw new Error("message shape changed: " + msg);
  if (!isAbsolute(m[1])) throw new Error("path not absolute: " + m[1]);
});
