import { test } from "node:test";
import { equal, ok, rejects, match } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { askLeaf } from "../src/ask.mjs";
import { initResultsDir, writeResult, readResult } from "../src/results.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  timeoutMs: 600000,
};

function setup(resultOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-"));
  initResultsDir(dir);
  writeResult(dir, "leaf", {
    id: "leaf", model: "haiku", ok: true, exit: 0, durationMs: 5,
    output: "original finding", sessionId: "s-1", cwd: tmpdir(), allowedTools: "Read,Grep",
    ...resultOver,
  });
  return dir;
}

const STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s-2" }),
  JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "the follow-up answer",
    usage: { input_tokens: 900, output_tokens: 80 },
  }),
].join("\n") + "\n";

test("askLeaf resumes the leaf session with its own model, cwd, and tools", async () => {
  const dir = setup();
  try {
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const io = makeIo(spawn);
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "why though?", cfg: CFG, io });

    equal(r.answer, "the follow-up answer");
    equal(r.tokens.input, 900);
    const call = spawn.calls[0];
    equal(promptOf(call), "why though?");
    const args = call.args;
    equal(args[args.indexOf("--resume") + 1], "s-1");
    equal(args[args.indexOf("--model") + 1], "haiku");
    equal(args[args.indexOf("--allowedTools") + 1], "Read,Grep");
    equal(call.opts.cwd, tmpdir());

    // thread continuity: next ask resumes the NEW session id
    equal(readResult(dir, "leaf").sessionId, "s-2");
    // Q/A appended to the interrogation log
    const log = readFileSync(join(dir, "results", "leaf.ask.log"), "utf8");
    ok(log.includes("why though?"), log);
    ok(log.includes("the follow-up answer"), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: readable errors for unknown leaf, missing sessionId, vanished cwd", async () => {
  const dir = setup();
  try {
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "ghost", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /no result/);
    writeResult(dir, "old", { id: "old", model: "haiku", ok: true, output: "x", cwd: tmpdir() });
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "old", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /sessionId/);
    writeResult(dir, "gone", { id: "gone", model: "haiku", ok: true, output: "x", sessionId: "s-9", cwd: join(tmpdir(), "swarm-nonexistent-wt-xyz") });
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "gone", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /no longer exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: --model override to an open model re-runs the governance gate", async () => {
  const dir = setup();
  try {
    // cwd (tmpdir) not under allowedRoots -> refused before any spawn
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    await rejects(
      () => askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", model: "glm-4.6:cloud", cfg: CFG, io: makeIo(spawn) }),
      /governance/i
    );
    equal(spawn.calls.length, 0);

    // under an allowed root -> dispatches with the env trio
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } };
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    const io2 = makeIo(spawn2);
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", model: "glm-4.6:cloud", cfg: cfgAllowed, io: io2 });
    equal(r.answer, "the follow-up answer");
    equal(spawn2.calls[0].opts.env.ANTHROPIC_MODEL, "glm-4.6:cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: governance gates on originalCwd for scratch-redirected leaves", async () => {
  // a write-capable open-model leaf runs in a scratch dir (never under
  // allowedRoots) but was approved against its ORIGINAL cwd — ask must honor
  // the same pair the manifest gate approved
  const dir = setup({ cwd: tmpdir(), originalCwd: join(tmpdir(), "approved-root") });
  try {
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [join(tmpdir(), "approved-root")] } };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", model: "glm-4.6:cloud", cfg: cfgAllowed, io: makeIo(spawn) });
    equal(r.answer, "the follow-up answer");
    equal(spawn.calls[0].opts.cwd, tmpdir()); // resume still runs in the leaf's actual cwd
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: a failed resume surfaces the raw error, does not update sessionId", async () => {
  const dir = setup();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "No conversation found with session ID s-1" }));
    await rejects(
      () => askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", cfg: CFG, io: makeIo(spawn) }),
      /No conversation found/
    );
    equal(readResult(dir, "leaf").sessionId, "s-1");
    ok(!existsSync(join(dir, "results", "leaf.ask.log")), "no ask log on failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
