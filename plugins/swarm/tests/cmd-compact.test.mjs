// The `swarm compact` subcommand: transcripts on disk lose their image bytes, a
// live run is left alone, and a failed rename can never lose the original.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { runCliInProcess } from "./helpers/cli.mjs";
import { tmp } from "./helpers/cli-fixture.mjs";
import { cmdCompact } from "../scripts/cmd-compact.mjs";
import { setSink } from "../src/ui.mjs";

const IMAGE = Buffer.alloc(4096, 7);
const plainLines = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
  JSON.stringify({ type: "result", subtype: "success" }),
];
const imageLine = () => JSON.stringify({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_use_id: "r1",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE.toString("base64") } }],
    }],
  },
});
const logText = () => [imageLine(), ...plainLines].join("\n") + "\n";
const stripped = (path) => readFileSync(path, "utf8").includes('"data":"[stripped]"');

// A run dir `runLiveness` calls finished: the run.log is written BEFORE the summary
// so its mtime never outgrows the terminal record. A live run carries a fresh
// heartbeat and no summary, which is the shape the engine writes mid-run.
function writeRun(runDir, { live = false } = {}) {
  mkdirSync(join(runDir, "results"), { recursive: true });
  writeFileSync(join(runDir, "run.log"), JSON.stringify({ ts: new Date().toISOString(), event: "run-start", tasks: [] }) + "\n");
  if (live) writeFileSync(join(runDir, "heartbeat"), `${new Date().toISOString()} ${process.pid}\n`);
  else writeFileSync(join(runDir, "summary.json"), JSON.stringify({ started: new Date().toISOString(), finished: new Date().toISOString(), tasks: [] }));
}

function capture() {
  const buf = { stdout: "", stderr: "" };
  const restore = setSink({
    stdout: { write: (s) => { buf.stdout += s; return true; } },
    stderr: { write: (s) => { buf.stderr += s; return true; } },
  });
  return { buf, restore };
}

const cli = (dir, args) => runCliInProcess(["compact", ...args], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });

test("K1: compact shrinks a .log, keeps every line parseable, leaves no .tmp, and never touches .ask.log", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const log = join(run, "results", "a.log");
    writeFileSync(log, logText());
    const ask = join(run, "results", "a.ask.log");
    writeFileSync(ask, "Q: why?\nA: because\n");
    const askBytes = readFileSync(ask);
    const askMtime = statSync(ask).mtimeMs;
    const beforeSize = statSync(log).size;

    const r = await cli(dir, [run]);
    equal(r.status, 0, r.stdout + r.stderr);

    const after = readFileSync(log);
    ok(after.length < beforeSize, `expected a shrink, got ${after.length} of ${beforeSize}`);
    for (const line of after.toString("utf8").split("\n").filter(Boolean)) JSON.parse(line);
    ok(stripped(log), after.toString("utf8").slice(0, 200));
    ok(!existsSync(`${log}.tmp`), "no .tmp left behind");
    deepEqual(readFileSync(ask), askBytes, "an ask log is plain Q/A, never a transcript");
    equal(statSync(ask).mtimeMs, askMtime, "an ask log is never rewritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K2: a second compact leaves the transcript byte-identical", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const log = join(run, "results", "a.log");
    writeFileSync(log, logText());
    equal((await cli(dir, [run])).status, 0);
    const once = readFileSync(log);
    equal((await cli(dir, [run])).status, 0);
    deepEqual(readFileSync(log), once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3a: a lone .log.gz becomes a stripped .log and the .gz is gone", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const gz = join(run, "results", "b.log.gz");
    writeFileSync(gz, gzipSync(logText()));

    const r = await cli(dir, [run]);
    equal(r.status, 0, r.stdout + r.stderr);
    ok(!existsSync(gz), "the .gz goes once the .log is in place");
    const log = join(run, "results", "b.log");
    ok(existsSync(log), "a plain transcript replaces it");
    ok(stripped(log));
    ok(!existsSync(`${log}.tmp`), "no .tmp left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3b: a rename that always fails leaves the .gz untouched and removes the .tmp", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const gz = join(run, "results", "b.log.gz");
    writeFileSync(gz, gzipSync(logText()));
    const gzBytes = readFileSync(gz);
    const failingFs = { ...fs, renameSync() { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } };

    const { buf, restore } = capture();
    let status;
    try {
      status = await cmdCompact([run], { usage: "usage", _fs: failingFs });
    } finally {
      restore();
    }

    equal(status, 0);
    deepEqual(readFileSync(gz), gzBytes, "the original .gz is untouched");
    ok(!existsSync(join(run, "results", "b.log")), "no .log is written past a failed rename");
    ok(!existsSync(join(run, "results", "b.log.tmp")), "the .tmp is cleaned up");
    ok(/rename failed/.test(buf.stderr), buf.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3c: a .gz with a sibling .log is skipped and reported, and neither file changes", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const gz = join(run, "results", "b.log.gz");
    const log = join(run, "results", "b.log");
    writeFileSync(gz, gzipSync("older transcript\n"));
    writeFileSync(log, plainLines.join("\n") + "\n");
    const gzBytes = readFileSync(gz);
    const logBytes = readFileSync(log);

    const r = await cli(dir, [run]);
    equal(r.status, 0, r.stdout + r.stderr);
    deepEqual(readFileSync(gz), gzBytes, "the .gz is never replaced when a .log is newer");
    deepEqual(readFileSync(log), logBytes, "the sibling .log is the one compact keeps");
    ok(r.stderr.includes(gz) && /sibling/.test(r.stderr), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: a live run is skipped and named; a finished run is compacted", async () => {
  const dir = tmp();
  try {
    const root = join(dir, "runs");
    const live = join(root, "proj", "live");
    const done = join(root, "proj", "done");
    writeRun(live, { live: true });
    writeRun(done);
    const liveLog = join(live, "results", "x.log");
    const doneLog = join(done, "results", "y.log");
    writeFileSync(liveLog, logText());
    writeFileSync(doneLog, logText());
    const liveBytes = readFileSync(liveLog);

    const r = await cli(dir, [root]);
    equal(r.status, 0, r.stdout + r.stderr);
    deepEqual(readFileSync(liveLog), liveBytes, "a live run's transcript is never rewritten");
    ok(stripped(doneLog), "a finished run is compacted");
    ok(r.stderr.includes(live) && /live/.test(r.stderr), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K5: --dry-run reports before and after bytes and writes nothing", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const log = join(run, "results", "a.log");
    writeFileSync(log, logText());
    const before = readFileSync(log);
    const mtime = statSync(log).mtimeMs;

    const r = await cli(dir, [run, "--dry-run"]);
    equal(r.status, 0, r.stdout + r.stderr);
    ok(/→/.test(r.stdout) && /dry run/.test(r.stdout), r.stdout);
    deepEqual(readFileSync(log), before, "dry run writes nothing");
    equal(statSync(log).mtimeMs, mtime, "dry run does not even touch the file");
    ok(!existsSync(`${log}.tmp`), "dry run leaves no .tmp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K6: a runs root is walked by shape, so a transcript three dirs down is found", async () => {
  const dir = tmp();
  try {
    const root = join(dir, "runs");
    const run = join(root, "proj", "r1");
    writeRun(run);
    const log = join(run, "results", "x.log");
    writeFileSync(log, logText());
    const beforeSize = statSync(log).size;

    const r = await cli(dir, [root]);
    equal(r.status, 0, r.stdout + r.stderr);
    ok(stripped(log), readFileSync(log, "utf8").slice(0, 200));
    ok(statSync(log).size < beforeSize);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
