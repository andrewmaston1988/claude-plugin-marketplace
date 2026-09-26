import { test } from "node:test";
import { deepEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildCodexInvocation,
  classifyCodexExit,
  createCodexAppServerClient,
  createCodexProviderAdapter,
  createCodexRunnerAdapter,
  discoverCodexModels,
  normalizeCodexModel,
} from "../src/codex.mjs";
import { isUnderRoot } from "../src/roots.mjs";
import { createCodexStreamParser, createRunnerParser } from "../src/stream.mjs";
import { addDirsOf } from "./helpers/fake-io.mjs";
import { assertProviderAdapterContract } from "./helpers/provider-contract.mjs";
import { assertRunnerAdapterContract } from "./helpers/runner-contract.mjs";

const SHIM = fileURLToPath(new URL("./shims/codex-shim.mjs", import.meta.url));

test("Codex app-server discovery initializes, follows cursors, and normalizes descriptors", async () => {
  const models = await discoverCodexModels({}, {
    executable: process.execPath,
    args: [SHIM, "app-server"],
    env: { SWARM_CODEX_SHIM_PAGE: "paged" },
  });
  deepEqual(models.map((model) => model.model), ["gpt-5-codex", "gpt-5-mini"]);
  deepEqual(models.map((model) => model.provider), ["codex", "codex"]);
  equal(models[0].runner, "codex");
});

// A stand-in child that answers initialize + model/list, so an injected spawnImpl
// can record the argv discovery really hands the process.
function recordingSpawn(seen) {
  return (cmd, args) => {
    seen.push([cmd, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write(line) {
        const message = JSON.parse(line);
        const result = message.method === "initialize"
          ? { serverInfo: { name: "stub" } }
          : { data: [{ id: "gpt-5-codex" }], nextCursor: null };
        setImmediate(() => child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
      },
    };
    child.kill = () => {};
    return child;
  };
}

// Discovery reads args off the same config block the usage reader does — a
// non-default appServerArgs that works for usage must work for model/list too.
test("Codex discovery spawns the app-server with the configured args", async () => {
  const seen = [];
  const spawnImpl = recordingSpawn(seen);
  const models = await discoverCodexModels(
    { providers: { codex: { path: "/opt/codex", appServerArgs: ["app-server", "--stdio", "--strict-config"] } } },
    { spawnImpl }
  );
  deepEqual(models.map((model) => model.model), ["gpt-5-codex"], "the configured args must still reach a working app-server");
  deepEqual(seen[0], ["/opt/codex", "app-server", "--stdio", "--strict-config"]);

  await discoverCodexModels({ providers: { codex: { path: "/opt/codex" } } }, { spawnImpl });
  deepEqual(seen[1], ["/opt/codex", "app-server", "--stdio"], "an unconfigured provider keeps the documented default");
});

test("Codex discovery deduplicates model rows from an injected client", async () => {
  const calls = [];
  const client = {
    async initialize() { calls.push("initialize"); },
    async request(method, params) {
      calls.push([method, params.cursor]);
      return { data: [{ id: "gpt-5-codex" }, { id: "gpt-5-codex" }], nextCursor: null };
    },
  };
  const models = await discoverCodexModels({}, { client });
  deepEqual(models, [{ provider: "codex", model: "gpt-5-codex", runner: "codex" }]);
  deepEqual(calls, ["initialize", ["model/list", null]]);
});

test("Codex model normalization preserves optional capabilities", () => {
  deepEqual(normalizeCodexModel({
    id: "gpt-5-codex",
    display_name: "GPT-5 Codex",
    supportedReasoningEfforts: ["low", { reasoningEffort: "high" }],
    inputModalities: ["text", "text"],
    isDefault: true,
  }), {
    provider: "codex",
    model: "gpt-5-codex",
    runner: "codex",
    displayName: "GPT-5 Codex",
    efforts: ["low", "high"],
    modalities: ["text"],
    isDefault: true,
  });
});

test("Codex runner invocation is sandboxed, resumable, and contract-valid", () => {
  const invocation = buildCodexInvocation({
    model: "gpt-5-codex",
    effort: "high",
    write: true,
    sessionId: "thread-123",
    additionalDirs: ["C:/repo"],
  }, "solve this", {});
  equal(invocation.argv[1], "exec");
  const resumeIndex = invocation.argv.indexOf("resume");
  ok(resumeIndex > 1);
  ok(invocation.argv.includes("--json"));
  ok(invocation.argv.includes("--sandbox") && invocation.argv.includes("workspace-write"));
  ok(invocation.argv.includes("thread-123"));
  ok(invocation.argv.includes("C:/repo"));
  const shim = spawnSync(process.execPath, [SHIM, ...invocation.argv.slice(1)], { encoding: "utf8" });
  equal(shim.status, 0, shim.stderr);
  throws(() => buildCodexInvocation({ model: "gpt-5-codex", sandbox: "danger-full-access" }, "x"), /read-only or workspace-write/);
  assertRunnerAdapterContract(createCodexRunnerAdapter(), { task: { provider: "codex", model: "gpt-5-codex" } });
});

// ── engine writeRoots → native directory arguments ────────────────────────────

// A `file` target has no file-level equivalent in `--add-dir`, so it contributes
// its containing directory; a `directory` target contributes itself.
test("Codex: writeRoots map a file target to its directory and a directory target to itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const run = join(dir, "run");
    const invocation = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: join(dir, "repo"), originalCwd: join(dir, "repo"),
      writeRoots: [
        { path: join(run, "scratch-__digest"), kind: "directory" },
        { path: join(run, "report.md"), kind: "file" },
      ],
    }, "write the report", {});
    deepEqual(addDirsOf(invocation.argv), [join(run, "scratch-__digest"), run]);
    ok(!invocation.argv.includes("--settings"), "Codex must never receive a Claude settings payload");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Two spellings of one directory must not produce two `--add-dir` arguments: a
// trailing separator and a `.` segment are the portable half of the comparison,
// win32 casing the platform half.
test("Codex: writeRoots de-duplicate against the primary cwd and against each other", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const run = join(dir, "run");
    const invocation = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: join(dir, "repo"), originalCwd: join(dir, "repo"),
      additionalDirs: [join(run, ".")],
      writeRoots: [
        { path: join(run, "report.md"), kind: "file" },      // → run, already an additionalDir
        { path: join(run, "scratch-__digest") + sep, kind: "directory" },
        { path: join(run, "scratch-__digest"), kind: "directory" }, // same dir, no separator
        { path: join(dir, "repo", "notes.md"), kind: "file" },      // → the primary cwd
      ],
    }, "write the report", {});
    // The FIRST spelling of a directory wins and is emitted verbatim; the later
    // spellings fold onto it through normalizeForCompare.
    deepEqual(addDirsOf(invocation.argv), [join(run, "."), join(run, "scratch-__digest") + sep]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Casing is folded by normalizeForCompare on win32 only; on posix two cased
// spellings are genuinely two directories.
test("Codex: win32 casing cannot produce a duplicate --add-dir", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const run = join(dir, "run");
    const invocation = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: join(dir, "repo"), originalCwd: join(dir, "repo"),
      additionalDirs: [run.toUpperCase()],
      writeRoots: [{ path: join(run.toLowerCase(), "report.md"), kind: "file" }],
    }, "write the report", {});
    deepEqual(addDirsOf(invocation.argv), [run.toUpperCase()]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Ordinary leaves must keep their argv byte-for-byte: configured entries first,
// in order, and the write-target directories appended after them.
test("Codex: additionalDirs keep their order and write targets append after them", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const run = join(dir, "run");
    const invocation = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: join(dir, "repo"), originalCwd: join(dir, "repo"),
      additionalDirs: [join(dir, "first"), join(dir, "second")],
      writeRoots: [{ path: join(run, "report.md"), kind: "file" }],
    }, "p", {});
    deepEqual(addDirsOf(invocation.argv), [join(dir, "first"), join(dir, "second"), run]);
    // Without the targets the argv is exactly what it was before this feature.
    const withoutTargets = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write",
      cwd: join(dir, "repo"), originalCwd: join(dir, "repo"),
      additionalDirs: [join(dir, "first"), join(dir, "second")],
    }, "p", {});
    deepEqual(withoutTargets.argv, [
      "codex", "exec", "--json", "--model", "gpt-5-codex", "-c", 'model_reasoning_effort="medium"',
      "--sandbox", "workspace-write",
      "--add-dir", join(dir, "first"), "--add-dir", join(dir, "second"),
      "p",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The accepted breadth, asserted rather than assumed: --add-dir grants a whole
// directory, so every directory the digest's OWN targets contribute stays at or
// under the run-private results dir. A configured additionalDirs entry is an
// independent pre-existing input and is outside this claim.
test("Codex: every --add-dir the write targets contribute stays under resultsDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const resultsDir = join(dir, "run");
    const invocation = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write", isDigest: true,
      cwd: join(resultsDir, "scratch-__digest"), originalCwd: dir,
      writeRoots: [
        { path: join(resultsDir, "scratch-__digest"), kind: "directory" },
        { path: join(resultsDir, "report.md"), kind: "file" },
      ],
    }, "write the report", {});
    // No additionalDirs configured, so every --add-dir here came from the targets.
    const contributed = addDirsOf(invocation.argv);
    ok(contributed.length >= 1, invocation.argv.join(" "));
    for (const d of contributed) ok(isUnderRoot(d, resultsDir), `${d} is outside ${resultsDir}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// `codex exec` refuses to start outside a Git repository, and the report digest's
// cwd is engine scratch. The allowance is scoped to the generated digest, placed
// with the other exec flags — the shim rejects exec options after `resume`.
test("Codex: --skip-git-repo-check is emitted for the digest only, before resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-codex-roots-"));
  try {
    const resultsDir = join(dir, "run");
    const digest = buildCodexInvocation({
      model: "gpt-5-codex", effort: "high", allowedTools: "Read,Write", isDigest: true,
      cwd: join(resultsDir, "scratch-__digest"), originalCwd: dir, resume: "thread-9",
      writeRoots: [
        { path: join(resultsDir, "scratch-__digest"), kind: "directory" },
        { path: join(resultsDir, "report.md"), kind: "file" },
      ],
    }, "write the report", {});
    const flagAt = digest.argv.indexOf("--skip-git-repo-check");
    const resumeAt = digest.argv.indexOf("resume");
    ok(flagAt > 0 && resumeAt > flagAt, `must precede resume: ${digest.argv.join(" ")}`);
    equal(digest.argv[resumeAt + 1], "thread-9");
    const shim = spawnSync(process.execPath, [SHIM, ...digest.argv.slice(1)], { encoding: "utf8" });
    equal(shim.status, 0, `the shim rejects exec options after resume: ${shim.stderr}`);
    equal(digest.argv[digest.argv.indexOf("--sandbox") + 1], "workspace-write");

    // An ordinary Codex leaf keeps the repo-root gate: same cwd, no allowance.
    const leaf = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read,Write", cwd: dir, originalCwd: dir,
    }, "inspect", {});
    ok(!leaf.argv.includes("--skip-git-repo-check"), leaf.argv.join(" "));

    // ...and neither does a digest that launches in place.
    const inPlace = buildCodexInvocation({
      model: "gpt-5-codex", allowedTools: "Read", isDigest: true, cwd: dir, originalCwd: dir,
    }, "summarize", {});
    ok(!inPlace.argv.includes("--skip-git-repo-check"), inPlace.argv.join(" "));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The digest's sandbox follows the same write-capability rule as any other task:
// no report block, no Write, so read-only — and nothing to add. It also stays in
// the dispatching repo (buildDigestTask gives a read-only digest plan.cwd), which
// is why it needs no launch allowance either.
test("Codex: a read-only digest is read-only sandboxed, with no --add-dir and no allowance", () => {
  const invocation = buildCodexInvocation({
    model: "gpt-5-codex", allowedTools: "Read", isDigest: true,
    cwd: "C:/work", originalCwd: "C:/work",
  }, "summarize", {});
  equal(invocation.argv[invocation.argv.indexOf("--sandbox") + 1], "read-only");
  deepEqual(addDirsOf(invocation.argv), []);
  ok(!invocation.argv.includes("--skip-git-repo-check"));
  ok(!invocation.argv.includes("--settings"));
});

test("Codex parser normalizes JSONL text, usage, and terminal failure", () => {
  const events = [];
  const parser = createCodexStreamParser({ emit: (event) => events.push(event) });
  parser.feed('{"type":"thread.started","thread_id":"thread-1"}\n');
  parser.feed('{"type":"response.output_text.delta","item_id":"m1","delta":"hel"}\n{"type":"response.output_text.delta","item_id":"m1","delta":"lo"}\n');
  parser.feed('{"type":"turn.completed","model":"gpt-5-codex","usage":{"input_tokens":20,"output_tokens":5,"cached_input_tokens":3}}\n');
  parser.end();
  deepEqual(parser.result(), {
    sessionId: "thread-1",
    realModel: "gpt-5-codex",
    output: "hello",
    usage: { input: 17, output: 5, cacheCreation: 0, cacheRead: 3 },
    terminal: true,
    numTurns: 1,
  });
  equal(events.filter((event) => event.terminal === true).length, 1);
  equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "hello");

  const finalOnly = createCodexStreamParser();
  finalOnly.feed('{"type":"turn.completed","output_text":"final-only"}\n');
  finalOnly.end();
  equal(finalOnly.result().output, "final-only");

  const failed = [];
  const errors = [];
  const completions = [];
  const incomplete = createCodexStreamParser({
    emit: (event) => failed.push(event),
    onError: (event) => errors.push(event),
    onComplete: (event) => completions.push(event),
  });
  incomplete.feed('{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"partial"}}\n');
  incomplete.end();
  equal(failed.at(-1).type, "error");
  equal(errors.length, 1);
  equal(completions.length, 0);
  match(String(failed.at(-1).error.code), /missing_terminal/);
  const classified = classifyCodexExit({ code: 0 }, incomplete.result(), { model: "gpt-5-codex" });
  equal(classified.terminal, false);
  match(String(classified.error.code), /missing_terminal/);
});

test("Codex parser output is the final agent message, never reasoning or interim items", () => {
  const parser = createCodexStreamParser();
  parser.feed([
    '{"type":"thread.started","thread_id":"thread-2"}',
    '{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"**Planning the scan**"}}',
    '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"I will read the file first."}}',
    '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"cat a.txt","aggregated_output":"x","status":"completed"}}',
    '{"type":"item.completed","item":{"id":"e1","type":"error","message":"transient tool warning"}}',
    '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"item.completed","item":{"id":"r2","type":"reasoning","text":"**Wrapping up**"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    "",
  ].join("\n"));
  parser.end();
  equal(parser.result().output, '{"ok":true}');
});

test("Codex app-server rejects a request when stdin fails synchronously", async () => {
  const child = {
    stdin: { write() { throw new Error("broken pipe"); } },
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill() {},
  };
  const client = createCodexAppServerClient({ spawnImpl: () => child });
  await rejects(() => client.request("model/list"), /broken pipe/);
  equal(client.diagnostics.pending, 0);
});

test("Codex runner parser registry exposes both provider factories", () => {
  ok(createRunnerParser("codex", { emit: () => {} }));
  ok(createRunnerParser("claude", { emit: () => {} }));
});

test("Codex provider adapter passes the concrete provider contract", async () => {
  const client = {
    async initialize() {},
    async request() { return { data: [{ id: "gpt-5-codex" }], nextCursor: null }; },
  };
  const adapter = createCodexProviderAdapter({ client });
  await assertProviderAdapterContract(adapter, {
    config: { providers: { codex: { enabled: true } } },
    context: { client },
  });
  equal(adapter.enabled({ providers: { codex: { enabled: false } } }), false);
});

test("Codex app-server client reports request timeouts and closes once", async () => {
  const client = createCodexAppServerClient({
    executable: process.execPath,
    args: [SHIM, "app-server"],
    timeoutMs: 20,
  });
  await rejects(() => client.request("unknown-method", {}, { requestTimeoutMs: 20 }), /timed out|exited/);
  client.close();
  client.close();
  equal(client.diagnostics.closed, true);
});

test("Codex exit classification returns the canonical run result", () => {
  deepEqual(classifyCodexExit({ code: 0 }, {
    provider: "codex", model: "gpt-5-codex", output: "ok", terminal: true,
  }, { model: "gpt-5-codex" }), {
    provider: "codex", model: "gpt-5-codex", output: "ok", terminal: true,
  });
});
