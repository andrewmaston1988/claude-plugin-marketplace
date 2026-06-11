// publisher (notifier-agnostic envelope writer + on_write hook).
//
// Covers: schema validity, drop-dir resolution, hook spawn shape, dryRun
// behavior, missing-input error paths.
import { test } from "node:test";
import { equal, match, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishReport, publishNotification } from "../scripts/publisher.mjs";

function freshPaths() {
  const tmp = mkdtempSync(join(tmpdir(), "smoke16-"));
  return {
    tmp,
    paths: { stateDir: join(tmp, "state"), dataDir: join(tmp, "data") },
  };
}

function readEnvelopes(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

test("publishNotification: writes JSON envelope to <stateDir>/notifications/", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const ok2 = await publishNotification(
      { title: "Test Alert", message: "body content", priority: "high" },
      { _cfg: { notifications: {} }, _paths: paths }
    );
    ok(ok2);
    const envelopes = readEnvelopes(join(paths.stateDir, "notifications"));
    equal(envelopes.length, 1);
    equal(envelopes[0].schema_version, 1);
    equal(envelopes[0].kind, "notification");
    equal(envelopes[0].title, "Test Alert");
    equal(envelopes[0].priority, "high");
    match(envelopes[0].body, /body content/);
    match(envelopes[0].timestamp, /^\d{8}T\d{6}Z$/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("publishNotification: messageFile takes precedence over message", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const msgFile = join(tmp, "msg.txt");
    writeFileSync(msgFile, "from-file", "utf8");
    await publishNotification(
      { title: "Source", message: "from-string", messageFile: msgFile },
      { _cfg: { notifications: {} }, _paths: paths }
    );
    const envelopes = readEnvelopes(join(paths.stateDir, "notifications"));
    equal(envelopes[0].body, "from-file");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("publishNotification: returns false when title missing", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const result = await publishNotification(
      { message: "no title" },
      { _cfg: { notifications: {} }, _paths: paths }
    );
    equal(result, false);
    ok(!existsSync(join(paths.stateDir, "notifications")));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("publishNotification: returns false when neither message nor messageFile given", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const result = await publishNotification(
      { title: "no body" },
      { _cfg: { notifications: {} }, _paths: paths }
    );
    equal(result, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("publishNotification: dryRun does not write a file", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const result = await publishNotification(
      { title: "T", message: "B" },
      { dryRun: true, _cfg: { notifications: {} }, _paths: paths }
    );
    ok(result);
    ok(!existsSync(join(paths.stateDir, "notifications")));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("publishReport: wraps a markdown report in a JSON envelope", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const report = join(tmp, "report.md");
    writeFileSync(report, "# Cache Health — 20260608\n\nbody line one.\n", "utf8");
    await publishReport(report, { _cfg: { notifications: {} }, _paths: paths });
    const envelopes = readEnvelopes(join(paths.stateDir, "notifications"));
    equal(envelopes.length, 1);
    equal(envelopes[0].kind, "report");
    equal(envelopes[0].title, "Cache Health — 20260608");
    equal(envelopes[0].source_file, report);
    match(envelopes[0].body, /body line one\./);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("publishReport: returns false when report file missing", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const result = await publishReport(
      join(tmp, "nope.md"),
      { _cfg: { notifications: {} }, _paths: paths }
    );
    equal(result, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("on_write hook is spawned with envelope path as argv", async () => {
  const { tmp, paths } = freshPaths();
  try {
    // Write a sentinel hook that records its argv to a file
    const hook = join(tmp, "hook.mjs");
    const sentinel = join(tmp, "hook-saw.txt");
    writeFileSync(hook, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv), "utf8");
    `, "utf8");
    await publishNotification(
      { title: "Hooked", message: "via hook" },
      { _cfg: { notifications: { on_write: hook } }, _paths: paths }
    );
    // Give the spawned child a moment to write
    await new Promise(r => setTimeout(r, 200));
    ok(existsSync(sentinel), "hook should have written sentinel");
    const argv = JSON.parse(readFileSync(sentinel, "utf8"));
    // argv = [node, hook.mjs, <envelope-file>]
    equal(argv.length, 3);
    match(argv[2], /hooked\.json$/);
    // Envelope should exist at the path the hook saw
    ok(existsSync(argv[2]));
    const env = JSON.parse(readFileSync(argv[2], "utf8"));
    equal(env.title, "Hooked");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("custom fallback_dir overrides default notifications/ location", async () => {
  const { tmp, paths } = freshPaths();
  try {
    const customDir = join(tmp, "custom-drop");
    await publishNotification(
      { title: "Custom", message: "body" },
      { _cfg: { notifications: { fallback_dir: customDir } }, _paths: paths }
    );
    const envelopes = readEnvelopes(customDir);
    equal(envelopes.length, 1);
    equal(envelopes[0].title, "Custom");
    // Default dir should not have been created
    ok(!existsSync(join(paths.stateDir, "notifications")));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
