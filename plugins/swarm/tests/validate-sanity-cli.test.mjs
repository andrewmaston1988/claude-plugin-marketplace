// Row 13 of the validate-sanity test plan: the torrent-hub incident shapes end to
// end through `swarm validate`. Each refusal is one round-trip from green, and the
// two warnings still approve the manifest.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { tmp } from "./helpers/cli-fixture.mjs";
import { writeRosterEntry } from "../src/roster.mjs";

const CLAUDE = "claude-haiku-4-5-20251001";
const ALL_PROVIDERS = {
  providers: {
    claude: { enabled: true, allowedRoots: [tmpdir()] },
    ollama: { enabled: true, allowedRoots: [tmpdir()] },
    codex: { enabled: true, allowedRoots: [tmpdir()] },
  },
};

function world(tasks, extra = {}, name = "m.json") {
  const dir = tmp();
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ tasks, ...extra }));
  return { dir, path, env: { SWARM_HOME: join(dir, "home") } };
}

const leaf = (over = {}) => ({ id: "lane", prompt: "do it", provider: "claude", model: CLAUDE, ...over });
const cli = (w, args, cwd = w.dir) => runCli(args, { cwd, env: w.env, config: ALL_PROVIDERS });
const cleanup = (w) => rmSync(w.dir, { recursive: true, force: true });

test("row 13: the verifier incident shape is refused, naming the edit tools and the shared tree", () => {
  const w = world([leaf({ id: "verify-a", role: "verifier", allowedTools: "Read,Edit,Write,Bash", workspace: "feat" })]);
  try {
    const r = cli(w, ["validate", w.path]);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(!r.stdout.includes("manifest OK"), `a refusal is never approved above it:\n${r.stdout}`);
    ok(r.stderr.includes("manifest validation failed:"), r.stderr);
    ok(r.stderr.includes('task \'verify-a\': role "verifier" may not hold edit tools'), r.stderr);
    ok(r.stderr.includes("may not name a workspace"), r.stderr);
    ok(r.stderr.includes('Drop "workspace"'), `the fix rides the message: ${r.stderr}`);
  } finally {
    cleanup(w);
  }
});

test("row 13: a 3 KB prompt in \"model\" is refused, and the 3 KB is not echoed back", () => {
  const prompt = Array.from({ length: 60 }, (_, i) => `step ${i}: read the file and report on it`).join(" ");
  ok(prompt.length > 2000, `fixture is the incident's size: ${prompt.length}`);
  const w = world([leaf({ model: prompt })]);
  try {
    const r = cli(w, ["validate", w.path]);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("not a model id"), r.stderr);
    ok(r.stderr.includes('prompt text belongs in "prompt"'), `the fix rides the message: ${r.stderr}`);
    ok(!r.stderr.includes(prompt), "the message quotes at most 60 characters of it");
    ok(!r.stdout.includes("seats:"), `it never reaches the seat list:\n${r.stdout}`);
  } finally {
    cleanup(w);
  }
});

test("row 13: a Codex seat on an Ollama-tagged model is refused", () => {
  const w = world([leaf({ provider: "codex", model: "deepseek-v4.1-flash:1017-cloud" })]);
  try {
    const r = cli(w, ["validate", w.path]);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("Ollama tag"), r.stderr);
    ok(r.stderr.includes('provider "codex" takes a Codex model id'), r.stderr);
    ok(!r.stdout.includes("manifest OK"), r.stdout);
  } finally {
    cleanup(w);
  }
});

// A finished run under a manifest edited since: the warning names exactly what a
// resume would re-run, and the manifest is still approved.
function finishedRun(dir) {
  mkdirSync(join(dir, "out", "results"), { recursive: true });
  writeFileSync(join(dir, "out", "results", "a.json"), JSON.stringify({ id: "a", ok: true, key: "0000000000000000" }));
  writeFileSync(join(dir, "out", "run.log"), '{"ts":"2026-11-15T10:00:00.000Z","event":"run-start","tasks":[]}\n');
  writeFileSync(join(dir, "out", "summary.json"), JSON.stringify({ finished: "2026-11-15T10:05:00.000Z" }));
}

test("row 13: an edited manifest over a finished run exits 0 and prints the resume warning", () => {
  const w = world([leaf({ id: "a" })], { resultsDir: "out" });
  try {
    finishedRun(w.dir);
    const r = cli(w, ["validate", w.path]);
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes("manifest OK"), r.stdout);
    const line = r.stdout.split("\n").find((l) => l.startsWith("warning:") && l.includes("holds an earlier run"));
    ok(line, r.stdout);
    ok(line.includes("(finished)"), line);
    ok(line.includes("a (definition changed)"), line);
  } finally {
    cleanup(w);
  }
});

test("row 13: `swarm run` loads the same manifest and says nothing about a resume", () => {
  // A second manifest over the same finished run: `run` has never validated these
  // bytes, so it refuses — after the load that would have printed the warning.
  const w = world([leaf({ id: "a" })], { resultsDir: "out" }, "other.json");
  try {
    finishedRun(w.dir);
    const r = cli(w, ["run", w.path]);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("has not been validated as written"), `the load happened: ${r.stderr}`);
    ok(!`${r.stdout}${r.stderr}`.includes("holds an earlier run"), "the preview is validate's alone");
  } finally {
    cleanup(w);
  }
});

test("row 13: an Ollama model missing from a non-empty banked roster warns and still passes", () => {
  const w = world([leaf({ provider: "ollama", model: "typo-model" })]);
  try {
    writeRosterEntry("ollama", {
      hydratedAt: Date.now(), source: null, models: [{ provider: "ollama", model: "real-model" }],
    }, { SWARM_HOME: w.env.SWARM_HOME });
    const r = cli(w, ["validate", w.path]);
    equal(r.status, 0, r.stdout + r.stderr);
    ok(r.stdout.includes("manifest OK"), r.stdout);
    const line = r.stdout.split("\n").find((l) => l.startsWith("warning:") && l.includes("swarm models"));
    ok(line, r.stdout);
    ok(line.includes("typo-model"), `the model is named: ${line}`);
  } finally {
    cleanup(w);
  }
});
