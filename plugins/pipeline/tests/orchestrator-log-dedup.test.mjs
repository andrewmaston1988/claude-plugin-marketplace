// Tests for makeLogger dedup and rotateLogs helpers (orchestrator-log-dedup plan).
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeLogger, rotateLogs } from "../scripts/orchestrator/index.mjs";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "orch-dedup-"));
  return { tmp, logFile: join(tmp, "orchestrator.jsonl") };
}

function teardown(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

function readLines(logFile) {
  try {
    return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

// ── dedup collapse ────────────────────────────────────────────────────────────

test("identical routine messages collapse to one write", () => {
  const { tmp, logFile } = setup();
  try {
    const log = makeLogger(logFile, { dedup: true });
    log("polling… 1 projects, 2 queued", "INFO", { routine: true });
    log("polling… 1 projects, 2 queued", "INFO", { routine: true });
    log("polling… 1 projects, 2 queued", "INFO", { routine: true });
    const lines = readLines(logFile);
    equal(lines.length, 1);
    equal(lines[0].msg, "polling… 1 projects, 2 queued");
  } finally { teardown(tmp); }
});

test("different routine keys each written once independently", () => {
  const { tmp, logFile } = setup();
  try {
    const log = makeLogger(logFile, { dedup: true });
    log("session active (scope=feature) — skipping", "INFO", { routine: true });
    log("global cap 3 reached — deferring [proj]", "INFO", { routine: true });
    log("polling… 1 projects, 1 queued", "INFO", { routine: true });
    log("session active (scope=feature) — skipping", "INFO", { routine: true });
    log("global cap 3 reached — deferring [proj]", "INFO", { routine: true });
    log("polling… 1 projects, 1 queued", "INFO", { routine: true });
    const lines = readLines(logFile);
    // Only the first occurrence of each key written; repeats suppressed
    equal(lines.length, 3);
    equal(lines[0].msg, "session active (scope=feature) — skipping");
    equal(lines[1].msg, "global cap 3 reached — deferring [proj]");
    equal(lines[2].msg, "polling… 1 projects, 1 queued");
  } finally { teardown(tmp); }
});

// ── flush on non-routine ──────────────────────────────────────────────────────

test("non-routine message flushes [N repeated] for each suppressed routine key", () => {
  const { tmp, logFile } = setup();
  try {
    const log = makeLogger(logFile, { dedup: true });
    log("polling… 1 projects", "INFO", { routine: true });
    log("polling… 1 projects", "INFO", { routine: true });
    log("polling… 1 projects", "INFO", { routine: true });
    // non-routine: triggers flush
    log("spawning session for feat-x", "INFO");
    const lines = readLines(logFile);
    // first occurrence + "[2 repeated]" flush + the spawn message
    equal(lines.length, 3);
    equal(lines[0].msg, "polling… 1 projects");
    equal(lines[1].msg, "[2 repeated]");
    equal(lines[1].level, "INFO");
    equal(lines[2].msg, "spawning session for feat-x");
  } finally { teardown(tmp); }
});

test("non-routine message does not emit flush when routine ran only once", () => {
  const { tmp, logFile } = setup();
  try {
    const log = makeLogger(logFile, { dedup: true });
    log("polling… 1 projects", "INFO", { routine: true });
    log("spawning session for feat-x", "INFO");
    const lines = readLines(logFile);
    // routine appeared once (count=1) — no flush needed
    equal(lines.length, 2);
    equal(lines[0].msg, "polling… 1 projects");
    equal(lines[1].msg, "spawning session for feat-x");
  } finally { teardown(tmp); }
});

test("multiple suppressed routine keys all flushed on non-routine", () => {
  const { tmp, logFile } = setup();
  try {
    const log = makeLogger(logFile, { dedup: true });
    log("session active — skipping", "INFO", { routine: true });
    log("global cap reached", "INFO", { routine: true });
    log("polling…", "INFO", { routine: true });
    log("session active — skipping", "INFO", { routine: true });
    log("global cap reached", "INFO", { routine: true });
    log("polling…", "INFO", { routine: true });
    // non-routine: flush all three accumulated keys
    log("error: db locked", "ERROR");
    const lines = readLines(logFile);
    // 3 first-occurrences + up to 3 flush lines (those with count > 1) + error
    const flushLines = lines.filter(l => l.msg.startsWith("["));
    ok(flushLines.length >= 1, "at least one flush line emitted");
    const errorLine = lines.find(l => l.msg === "error: db locked");
    ok(errorLine, "error message emitted");
    equal(errorLine.level, "ERROR");
  } finally { teardown(tmp); }
});

test("non-routine messages always emit even mid-collapse", () => {
  const { tmp, logFile } = setup();
  try {
    const log = makeLogger(logFile, { dedup: true });
    log("polling…", "INFO", { routine: true });
    log("polling…", "INFO", { routine: true });
    log("spawned session A", "INFO");
    log("polling…", "INFO", { routine: true });
    log("polling…", "INFO", { routine: true });
    log("spawned session B", "INFO");
    const lines = readLines(logFile);
    const spawnLines = lines.filter(l => l.msg.startsWith("spawned session"));
    equal(spawnLines.length, 2, "both non-routine spawns emitted");
  } finally { teardown(tmp); }
});

// ── dedup off (default) ───────────────────────────────────────────────────────

test("dedup disabled by default: all messages written", () => {
  const { tmp, logFile } = setup();
  try {
    const log = makeLogger(logFile);
    log("polling… 1 projects", "INFO", { routine: true });
    log("polling… 1 projects", "INFO", { routine: true });
    log("polling… 1 projects", "INFO", { routine: true });
    const lines = readLines(logFile);
    equal(lines.length, 3);
  } finally { teardown(tmp); }
});

// ── log rotation ──────────────────────────────────────────────────────────────

test("rotateLogs: no-op when file under 1MB", () => {
  const { tmp, logFile } = setup();
  try {
    writeFileSync(logFile, "x".repeat(512 * 1024), "utf8"); // 512KB
    rotateLogs(logFile);
    ok(statSync(logFile).size === 512 * 1024, "file unchanged");
    ok(!existsSilent(logFile + ".1"), "no .1 created");
  } finally { teardown(tmp); }
});

test("rotateLogs: no-op when file absent", () => {
  const { tmp, logFile } = setup();
  try {
    rotateLogs(logFile); // should not throw
  } finally { teardown(tmp); }
});

test("rotateLogs: rotates when file exceeds 1MB", () => {
  const { tmp, logFile } = setup();
  try {
    const content = "x".repeat(1_100_000);
    writeFileSync(logFile, content, "utf8");
    rotateLogs(logFile);
    ok(!existsSilent(logFile), "original file removed");
    ok(statSync(logFile + ".1").size === content.length, ".1 has original content");
  } finally { teardown(tmp); }
});

test("rotateLogs: cascades existing rotated files", () => {
  const { tmp, logFile } = setup();
  try {
    writeFileSync(logFile + ".1", "old1", "utf8");
    writeFileSync(logFile + ".2", "old2", "utf8");
    writeFileSync(logFile, "x".repeat(1_100_000), "utf8");
    rotateLogs(logFile);
    equal(readFileSync(logFile + ".2", "utf8"), "old1");
    equal(readFileSync(logFile + ".3", "utf8"), "old2");
    ok(!existsSilent(logFile), "original removed");
  } finally { teardown(tmp); }
});

test("rotateLogs: drops .jsonl.3 when rotating four files", () => {
  const { tmp, logFile } = setup();
  try {
    writeFileSync(logFile + ".1", "one", "utf8");
    writeFileSync(logFile + ".2", "two", "utf8");
    writeFileSync(logFile + ".3", "three-to-drop", "utf8");
    writeFileSync(logFile, "x".repeat(1_100_000), "utf8");
    rotateLogs(logFile);
    // .3 is overwritten with what was .2
    equal(readFileSync(logFile + ".3", "utf8"), "two");
  } finally { teardown(tmp); }
});

// ── helpers ───────────────────────────────────────────────────────────────────

function existsSilent(p) {
  try { statSync(p); return true; } catch { return false; }
}
