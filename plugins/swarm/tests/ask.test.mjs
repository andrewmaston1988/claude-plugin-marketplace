import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { askLeaf } from "../src/ask.mjs";
import {
  initResultsDir, writeResult, readResult, writeManifestSnapshot,
} from "../src/results.mjs";
import { fakeSpawnFactory, makeIo, promptOf, STREAM } from "./helpers/fake-io.mjs";

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  // An ask is root-gated for every provider now, Claude included — it does not reload the
  // manifest, so this is the only root check on the path. Every fixture lives under tmpdir.
  providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } },
  timeoutMs: 600000,
};

function setup(resultOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-"));
  initResultsDir(dir);
  writeResult(dir, "leaf", {
    id: "leaf", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5,
    output: "original finding", sessionId: "s-1", cwd: tmpdir(), allowedTools: "Read,Grep",
    ...resultOver,
  });
  writeManifestSnapshot(dir, { cwd: tmpdir(), resultsDir: dir, tasks: [{ id: "leaf", provider: "claude", model: "claude-haiku-4-5-20251001" }] });
  return dir;
}

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
    equal(args[args.indexOf("--model") + 1], "claude-haiku-4-5-20251001");
    // MCP is appended to every leaf, so pin the propagation, not the whole string.
    ok(args[args.indexOf("--allowedTools") + 1].startsWith("Read,Grep"));
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
    writeResult(dir, "old", { id: "old", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, output: "x", cwd: tmpdir() });
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "old", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /sessionId/);
    writeResult(dir, "gone", { id: "gone", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, output: "x", sessionId: "s-9", cwd: join(tmpdir(), "swarm-nonexistent-wt-xyz") });
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
      () => askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", provider: "ollama", model: "glm-4.6:cloud", cfg: CFG, io: makeIo(spawn) }),
      /governance/i
    );
    equal(spawn.calls.length, 0);

    // under an allowed root -> dispatches with the env trio
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [tmpdir()] } };
    const spawn2 = fakeSpawnFactory(() => ({ output: STREAM }));
    const io2 = makeIo(spawn2);
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", provider: "ollama", model: "glm-4.6:cloud", cfg: cfgAllowed, io: io2 });
    equal(r.answer, "the follow-up answer");
    equal(spawn2.calls[0].opts.env.ANTHROPIC_MODEL, "glm-4.6:cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: explicit provider override reaches the provider runner", async () => {
  const dir = setup();
  try {
    const root = tmpdir();
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, allowedRoots: [] },
        codex: { enabled: true, path: "codex", allowedRoots: [root] },
      },
    };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const answer = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "why?", model: "gpt-5-codex", provider: "codex", cfg, io: makeIo(spawn) });
    equal(spawn.calls[0].cmd, "codex");
    ok(!spawn.calls[0].opts.env.ANTHROPIC_MODEL, "Codex ask must not use the Ollama env route");
    equal(answer.provider, "codex");
    const stored = JSON.parse(readFileSync(join(dir, "results", "leaf.json"), "utf8"));
    equal(stored.asks.at(-1).provider, "codex");
    ok(stored.provider !== "codex", "an override must not rewrite the leaf's own identity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: an unmodified Codex leaf reuses the provider persisted in the manifest snapshot", async () => {
  const dir = setup({ provider: undefined, model: "gpt-5-codex" });
  try {
    writeManifestSnapshot(dir, { cwd: tmpdir(), resultsDir: dir, tasks: [{ id: "leaf", model: "gpt-5-codex", provider: "codex" }] });
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, allowedRoots: [] },
        codex: { enabled: true, path: "codex", allowedRoots: [tmpdir()] },
      },
    };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    await askLeaf({ resultsDir: dir, taskId: "leaf", question: "why?", cfg, io: makeIo(spawn) });
    equal(spawn.calls[0].cmd, "codex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: disabled provider override fails before any spawn", async () => {
  const dir = setup();
  try {
    const cfg = {
      ...CFG,
      providers: {
        claude: { enabled: true },
        ollama: { enabled: true, allowedRoots: [] },
        codex: { enabled: false, allowedRoots: [tmpdir()] },
      },
    };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    await rejects(
      () => askLeaf({ resultsDir: dir, taskId: "leaf", question: "why?", model: "gpt-5-codex", provider: "codex", cfg, io: makeIo(spawn) }),
      /disabled/i,
    );
    equal(spawn.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: governance gates on originalCwd when the leaf runs elsewhere than it was approved", async () => {
  // a write-capable open-model leaf runs in its tree (never under
  // allowedRoots) but was approved against its ORIGINAL cwd — ask must honor
  // the same pair the manifest gate approved
  const dir = setup({ cwd: tmpdir(), originalCwd: join(tmpdir(), "approved-root") });
  try {
    const cfgAllowed = { ...CFG, provider: { ...CFG.provider, allowedRoots: [join(tmpdir(), "approved-root")] } };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", provider: "ollama", model: "glm-4.6:cloud", cfg: cfgAllowed, io: makeIo(spawn) });
    equal(r.answer, "the follow-up answer");
    equal(spawn.calls[0].opts.cwd, tmpdir()); // resume still runs in the leaf's actual cwd
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: a failed resume surfaces ok:false, does not update sessionId", async () => {
  const dir = setup();
  try {
    const spawn = fakeSpawnFactory(() => ({ exit: 1, output: "No conversation found with session ID s-1" }));
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", cfg: CFG, io: makeIo(spawn) });
    equal(r.ok, false);
    ok(r.answer.includes("No conversation found"), r.answer);
    equal(readResult(dir, "leaf").sessionId, "s-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: resumes a forEach clone whose id is not a top-level manifest task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-ask-clone-"));
  try {
    initResultsDir(dir);
    // "fix" is the forEach parent in the manifest; "fix[0]" only exists as an
    // expanded clone with its own result — never a key in manifest.tasks.
    writeManifestSnapshot(dir, { cwd: tmpdir(), resultsDir: dir, tasks: [{ id: "fix", provider: "claude", model: "claude-haiku-4-5-20251001", forEach: { over: "{{x}}" } }] });
    writeResult(dir, "fix[0]", {
      id: "fix[0]", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, exit: 0, durationMs: 5,
      output: "clone finding", sessionId: "s-clone", cwd: tmpdir(), allowedTools: "Read,Grep",
    });
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const io = makeIo(spawn);
    const r = await askLeaf({ resultsDir: dir, taskId: "fix[0]", question: "why though?", cfg: CFG, io });

    equal(r.answer, "the follow-up answer");
    const args = spawn.calls[0].args;
    equal(args[args.indexOf("--resume") + 1], "s-clone");
    equal(readResult(dir, "fix[0]").asks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The snapshot re-add is gone: a reader's cwd is the live repo and is still there, so there
// is nothing to re-create and nothing to leak. What is left is the one case where a cwd can
// genuinely be absent — a writer's tree that was swept for changing nothing.
test("askLeaf: a writer whose tree was swept gets the teaching message, not the generic one", async () => {
  const dir = setup();
  try {
    writeResult(dir, "swept", { id: "swept", provider: "claude", model: "claude-haiku-4-5-20251001", ok: true, output: "x", sessionId: "s-9", worktree: { branch: "swarm/swept" }, cwd: join(tmpdir(), "swarm-nonexistent-wt-xyz") });
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "swept", question: "?", cfg: CFG, io: makeIo(fakeSpawnFactory()) }), /removed because it changed nothing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An ask never reloads the manifest, so this is the only root check on the path — and it
// reads the SAME pair the manifest gate approved. Reading providers.<id>.allowedRoots
// directly leaves a top-level list silently ignored here.
test("askLeaf: a provider armed only at the top level is root-gated on originalCwd", async () => {
  const approved = join(tmpdir(), "swarm-ask-approved-root");
  const dir = setup({ cwd: tmpdir(), originalCwd: approved });
  try {
    const cfg = {
      ...CFG,
      allowedRoots: [approved],
      providers: { claude: { enabled: true }, ollama: { enabled: true } },
    };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    const r = await askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", provider: "ollama", model: "glm-4.6:cloud", cfg, io: makeIo(spawn) });
    equal(r.answer, "the follow-up answer");
    equal(spawn.calls[0].opts.cwd, tmpdir()); // resumed in the leaf's own cwd, approved against its original
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askLeaf: a top-level list that does not cover originalCwd refuses — Claude included", async () => {
  const dir = setup();
  try {
    const cfg = {
      ...CFG,
      allowedRoots: [join(tmpdir(), "swarm-ask-elsewhere")],
      providers: { claude: { enabled: true }, ollama: { enabled: true } },
    };
    const spawn = fakeSpawnFactory(() => ({ output: STREAM }));
    await rejects(
      () => askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", provider: "ollama", model: "glm-4.6:cloud", cfg, io: makeIo(spawn) }),
      /governance/i
    );
    // Unlike dispatch, ask gates EVERY provider including Claude — unchanged by the sweep.
    await rejects(() => askLeaf({ resultsDir: dir, taskId: "leaf", question: "?", cfg, io: makeIo(spawn) }), /governance/i);
    equal(spawn.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
