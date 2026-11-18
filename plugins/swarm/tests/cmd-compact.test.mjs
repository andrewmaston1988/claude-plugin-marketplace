// The `swarm compact` subcommand: transcripts on disk lose their image bytes, a
// live run is left alone, and a failed rename can never lose the original.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import * as fs from "node:fs";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { runCliInProcess } from "./helpers/cli.mjs";
import { tmp } from "./helpers/cli-fixture.mjs";
import { cmdCompact } from "../scripts/cmd-compact.mjs";
import { stripImages } from "../src/log-line-filter.mjs";
import { setSink } from "../src/ui.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

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

    equal(status, 1);
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

test("K7a: the configured heartbeat window decides liveness, not the 15 s default", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run, { live: true });
    const hb = join(run, "heartbeat");
    const old = new Date(Date.now() - 50_000);
    utimesSync(hb, old, old);
    const log = join(run, "results", "x.log");
    writeFileSync(log, logText());
    const bytes = readFileSync(log);

    const { buf, restore } = capture();
    let status;
    try {
      status = await cmdCompact([run], { usage: "usage", _getConfig: () => ({ heartbeatSecs: 60 }) });
    } finally {
      restore();
    }

    equal(status, 0);
    deepEqual(readFileSync(log), bytes, "50 s is inside 3 x 60 s, so the run is live and untouched");
    ok(/live/.test(buf.stderr), buf.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K7b: a directory at the .tmp path fails that file, carries on and exits 1", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const a = join(run, "results", "a.log");
    const b = join(run, "results", "b.log");
    writeFileSync(a, logText());
    writeFileSync(b, logText());
    const aBytes = readFileSync(a);
    mkdirSync(`${a}.tmp`);

    const { buf, restore } = capture();
    let status;
    try {
      status = await cmdCompact([run], { usage: "usage" });
    } finally {
      restore();
    }

    equal(status, 1, buf.stdout + buf.stderr);
    deepEqual(readFileSync(a), aBytes, "the file that could not be written is untouched");
    ok(stripped(b), "compact carries on to the next transcript");
    ok(buf.stderr.includes(a) && /skipped/.test(buf.stderr), buf.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K7c: a CRLF transcript keeps CRLF and its unterminated final line", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const log = join(run, "results", "a.log");
    writeFileSync(log, [imageLine(), plainLines[0], plainLines[1]].join("\r\n"));

    const r = await cli(dir, [run]);
    equal(r.status, 0, r.stdout + r.stderr);

    const after = readFileSync(log, "utf8");
    ok(stripped(log));
    equal(after.replace(/\r\n/g, "").includes("\n"), false, "every newline stays CRLF");
    ok(!after.endsWith("\n"), "an unterminated tail gains no terminator");
    ok(after.endsWith(plainLines[1]), "the tail is byte-for-byte");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K7d: a .log.gz with no image stays compressed and untouched", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const gz = join(run, "results", "b.log.gz");
    writeFileSync(gz, gzipSync(plainLines.join("\n") + "\n"));
    const bytes = readFileSync(gz);

    const r = await cli(dir, [run]);
    equal(r.status, 0, r.stdout + r.stderr);
    deepEqual(readFileSync(gz), bytes, "nothing to strip leaves the compressed file alone");
    ok(!existsSync(join(run, "results", "b.log")), "no plain .log is written");
    ok(/nothing to strip/.test(r.stderr), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K7e: an unknown flag is refused with exit 1 before anything is written", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const log = join(run, "results", "a.log");
    writeFileSync(log, logText());
    const bytes = readFileSync(log);

    const r = await cli(dir, [run, "--dryrun"]);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(/unknown option/.test(r.stderr), r.stderr);
    ok(/usage:/.test(r.stderr), r.stderr);
    deepEqual(readFileSync(log), bytes, "a refused flag must never strip for real");
    ok(!existsSync(`${log}.tmp`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── backpressure and the second Read copy ─────────────────────────────────────

// A genuine Writable that reports backpressure on every write and drains a tick
// later, so several writes land inside one pause window.
class SlowWriter extends Writable {
  constructor(path) {
    super({ highWaterMark: 1 });
    this.path = path;
    this.bytes = [];
    this.maxDrainListeners = 0;
    this.on("newListener", (event) => {
      if (event === "drain") this.maxDrainListeners = Math.max(this.maxDrainListeners, this.listenerCount("drain") + 1);
    });
  }

  // Landed on disk too, so the rename downstream has a real .tmp to move.
  _write(chunk, _enc, cb) {
    this.bytes.push(Buffer.from(chunk));
    setImmediate(() => {
      appendFileSync(this.path, chunk);
      cb();
    });
  }
}

// What #475 left behind: the content copy stubbed, the Read tool's own copy raw.
const compactedLine = () => JSON.stringify({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_use_id: "r1",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "[stripped]", bytes: IMAGE.length, sha256: sha256(IMAGE) },
      }],
    }],
  },
  tool_use_result: {
    type: "image",
    file: { base64: IMAGE.toString("base64"), type: "image/png", originalSize: IMAGE.length },
  },
});

test("R4: a backpressured compact keeps one drain listener and writes every line once", async () => {
  const dir = tmp();
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    const run = join(dir, "run");
    writeRun(run);
    const log = join(run, "results", "big.log");
    // ~3.5 KB lines: one 64 KiB read chunk holds several complete lines, so many
    // writes land inside a single pause window.
    const filler = "x".repeat(3500);
    const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `${i}:${filler}` }] } }));
    lines.splice(20, 0, imageLine());
    writeFileSync(log, lines.join("\n") + "\n");
    const expected = Buffer.concat(lines.map((line) => stripImages(Buffer.from(`${line}\n`, "utf8"))));

    let writer;
    const injected = {
      ...fs,
      createWriteStream: (path) => {
        writeFileSync(path, "");
        writer = new SlowWriter(path);
        return writer;
      },
    };
    const { buf, restore } = capture();
    let status;
    try {
      status = await cmdCompact([run], { usage: "usage", _fs: injected });
    } finally {
      restore();
    }

    equal(status, 0, buf.stdout + buf.stderr);
    equal(writer.maxDrainListeners, 1, "one drain listener per pause, never one per write");
    deepEqual(Buffer.concat(writer.bytes), expected, "every line written once, in order");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning").map((w) => w.message), []);
    ok(stripped(log));
  } finally {
    process.off("warning", onWarning);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5: a #475-compacted transcript shrinks again, and a further compact is byte-identical", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "run");
    writeRun(run);
    const log = join(run, "results", "a.log");
    writeFileSync(log, [compactedLine(), ...plainLines].join("\n") + "\n");
    const before = statSync(log).size;

    equal((await cli(dir, [run])).status, 0);
    const once = readFileSync(log);
    ok(once.length < before, `expected a shrink, got ${once.length} of ${before}`);
    const doc = JSON.parse(once.toString("utf8").split("\n")[0]);
    equal(doc.message.content[0].content[0].source.data, "[stripped]", "the #475 stub is untouched");
    equal(doc.tool_use_result.file.base64, "[stripped]");
    equal(doc.tool_use_result.file.bytes, IMAGE.length);
    equal(doc.tool_use_result.file.sha256, sha256(IMAGE));

    equal((await cli(dir, [run])).status, 0);
    deepEqual(readFileSync(log), once, "a third pass is byte-identical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
