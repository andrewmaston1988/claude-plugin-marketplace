import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { ASPECTS } from "../src/aspects.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-grade-cli-"));
}

// A finished run on disk: two :cloud leaves and one Claude leaf, which the
// store is not interested in.
function fakeRun(dir) {
  const run = join(dir, "run-1");
  mkdirSync(join(run, "results"), { recursive: true });
  const write = (id, obj) => writeFileSync(join(run, "results", `${id}.json`), JSON.stringify(obj, null, 2));
  write("icons", { id: "icons", model: "glm-5.2:cloud", ok: true, exit: 0, durationMs: 41000, numTurns: 6, output: "…" });
  write("pack", { id: "pack", model: "kimi-k2.7-code:cloud", ok: true, exit: 0, durationMs: 90000, numTurns: 12, output: "…" });
  write("verdict", { id: "verdict", model: "sonnet", ok: true, exit: 0, durationMs: 5000, output: "…" });
  writeFileSync(join(run, "manifest.json"), JSON.stringify({ tasks: [{ id: "icons", effort: null }] }));
  return run;
}

test("grade --init: one row per :cloud leaf, Claude leaves skipped", () => {
  const dir = tmp();
  try {
    const run = fakeRun(dir);
    const r = runCli(["grade", "--init", run], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    const batch = JSON.parse(readFileSync(join(run, "grades.json"), "utf8"));
    equal(batch.rows.length, 2);
    ok(!batch.rows.some((x) => x.leaf === "verdict"), "a Claude leaf produced a row");
    // every aspect key present and null — the skeleton is a form to fill, and
    // validation refuses it until it has been
    for (const row of batch.rows) {
      for (const a of ASPECTS) equal(row.grades[a], null, `${row.leaf}.${a}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grade --init: a run with no :cloud leaves says so rather than writing an empty form", () => {
  const dir = tmp();
  try {
    const run = join(dir, "claude-only");
    mkdirSync(join(run, "results"), { recursive: true });
    writeFileSync(join(run, "results", "a.json"), JSON.stringify({ id: "a", model: "opus", ok: true }));
    const r = runCli(["grade", "--init", run], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1);
    ok(r.stderr.includes("no :cloud leaves"), r.stderr);
    ok(!existsSync(join(run, "grades.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grade --file: an untouched skeleton is refused and nothing is written", () => {
  const dir = tmp();
  try {
    const run = fakeRun(dir);
    const home = join(dir, "home");
    runCli(["grade", "--init", run], { cwd: dir, env: { SWARM_HOME: home } });
    const r = runCli(["grade", "--file", join(run, "grades.json")], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 1);
    ok(r.stderr.includes("session"), r.stderr);
    ok(!existsSync(join(home, "model-scores.jsonl")), "the store was created from an untouched form");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grade --file: a leaf with no result on disk fails loudly and writes nothing", () => {
  const dir = tmp();
  try {
    const run = fakeRun(dir);
    const home = join(dir, "home");
    const p = join(dir, "grades.json");
    writeFileSync(p, JSON.stringify({
      resultsDir: run,
      session: "abc123",
      rows: [{ leaf: "ghost", domain: "godot", outcome: "completed", note: "", grades: { adherence: 8, handoff: 8, truthfulness: 8, depth: 8 } }],
    }));
    const r = runCli(["grade", "--file", p], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 1);
    ok(r.stderr.includes("ghost"), r.stderr);
    ok(r.stderr.includes("cannot be fabricated"), r.stderr);
    ok(!existsSync(join(home, "model-scores.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grade --file: a filled batch lands, with model and mechanical taken from the result", () => {
  const dir = tmp();
  try {
    const run = fakeRun(dir);
    const home = join(dir, "home");
    const p = join(dir, "grades.json");
    writeFileSync(p, JSON.stringify({
      resultsDir: run,
      session: "abc123",
      rows: [
        // the batch claims sonnet; the result says glm — the result wins
        { leaf: "icons", model: "sonnet", domain: "godot", outcome: "completed", note: "",
          grades: { adherence: 9, handoff: 7, truthfulness: 8, depth: 8, geometry: 8 } },
        { leaf: "pack", domain: "godot", outcome: "session-died", note: "died on an image read" },
      ],
    }));
    const r = runCli(["grade", "--file", p], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    const rows = readFileSync(join(home, "model-scores.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    equal(rows.length, 2);
    equal(rows[0].model, "glm-5.2:cloud");
    equal(rows[0].mechanical.numTurns, 6);
    equal(rows[0].mechanical.durationMs, 41000);
    equal(rows[1].grades, undefined, "a no-output row carried grades");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perf: an empty store prints all ten aspects at n=0", () => {
  const dir = tmp();
  try {
    const r = runCli(["perf"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    for (const a of ASPECTS) ok(r.stdout.includes(a), `${a} missing from an empty-store table`);
    ok(r.stdout.includes("n=0"), r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perf: an unknown aspect fails with the valid list", () => {
  const dir = tmp();
  try {
    const r = runCli(["perf", "--aspect", "godot"], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 1);
    ok(r.stderr.includes("unknown aspect"), r.stderr);
    ok(r.stderr.includes("discrimination"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
