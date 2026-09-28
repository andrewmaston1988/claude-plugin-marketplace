// The dispatch gate: `run` refuses a manifest whose exact bytes + args have not
// passed `validate`. Every row is observable from the CLI; the marker directory
// is the only internal and it is read as a filesystem fact, never re-derived.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./helpers/cli.mjs";
import { gitOut, tmp } from "./helpers/cli-fixture.mjs";
import { readRosterEnvelope, writeRosterEntry } from "../src/discovery.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const OTHER_MODEL = "claude-sonnet-5";
const REFUSAL = "has not been validated as written";

// A repo + a pre-gated home + one manifest writing into <dir>/out. The roster is
// seeded so the seats resolve with no live probe, and so a row has a
// defaultEffort to move underneath a validated manifest.
function world({ tasks, extra = {}, resultsDir = "out" } = {}) {
  const dir = tmp();
  const home = join(dir, "home");
  const env = { SWARM_HOME: home };
  writeRosterEntry("claude", { hydratedAt: Date.now(), source: null, models: [
    { provider: "claude", model: MODEL, efforts: ["low", "medium", "high"], defaultEffort: "high" },
    { provider: "claude", model: OTHER_MODEL, efforts: ["low", "medium", "high"], defaultEffort: "high" },
  ] }, env);
  const path = join(dir, "m.json");
  writeFileSync(path, JSON.stringify({
    ...(resultsDir ? { resultsDir } : {}),
    tasks: tasks ?? [{ id: "a", prompt: "x", provider: "claude", model: MODEL }],
    ...extra,
  }));
  return { dir, home, path };
}

const envOf = (w) => ({ SWARM_HOME: w.home, SWARM_SHIM_LOG: join(w.dir, "shim.log"), SWARM_SHIM_OUTPUT: "done" });
const validate = (w, extra = []) => runCli(["validate", w.path, ...extra], { cwd: w.dir, env: envOf(w) });
const run = (w, extra = []) => runCli(["run", w.path, ...extra], { cwd: w.dir, env: envOf(w) });
const shimLog = (w) => join(w.dir, "shim.log");
const edit = (w, mutate) => {
  const doc = JSON.parse(readFileSync(w.path, "utf8"));
  mutate(doc);
  writeFileSync(w.path, JSON.stringify(doc));
};
const markers = (w) => {
  const dir = join(w.home, "validated");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const cleanup = (w) => rmSync(w.dir, { recursive: true, force: true });

test("never validated: run exits 1 with the teaching line and spawns nothing", () => {
  const w = world();
  try {
    const r = run(w);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(REFUSAL), r.stderr);
    ok(r.stderr.includes("swarm validate"), r.stderr);
    ok(r.stderr.includes("seats block"), r.stderr);
    ok(!existsSync(shimLog(w)), "nothing may spawn before the gate passes");
    ok(!existsSync(join(w.dir, "out")), "no run dir may be created before the gate passes");
  } finally {
    cleanup(w);
  }
});

test("validated: validate then run on the same file proceeds, with one marker", () => {
  const w = world();
  try {
    const v = validate(w);
    equal(v.status, 0, v.stderr);
    equal(markers(w).length, 1, "validate writes exactly one marker");
    const r = run(w);
    equal(r.status, 0, r.stderr + r.stdout);
    ok(existsSync(shimLog(w)), "the leaf dispatches once the gate is satisfied");
    ok(existsSync(join(w.dir, "out", "run.log")), "the run dir exists");
  } finally {
    cleanup(w);
  }
});

test("validated: validating unchanged bytes again does not mint a second marker", () => {
  const w = world();
  try {
    equal(validate(w).status, 0);
    equal(validate(w).status, 0);
    equal(markers(w).length, 1, "the marker is keyed, not appended");
  } finally {
    cleanup(w);
  }
});

// Each of these is an edit the derived document used to hide: the resolved plan
// is unchanged by concurrency/timeoutMs/leafGuard, yet the run must refuse.
const MUTATIONS = [
  ["a seat's model", (d) => { d.tasks[0].model = OTHER_MODEL; }],
  ["concurrency", (d) => { d.concurrency = 2; }],
  ["timeoutMs", (d) => { d.timeoutMs = 1_200_000; }],
  ["a task's leafGuard", (d) => { d.tasks[0].leafGuard = false; }],
];

for (const [label, mutate] of MUTATIONS) {
  test(`validated: editing ${label} after validating makes run refuse`, () => {
    const w = world();
    try {
      equal(validate(w).status, 0, "the authored manifest validates");
      edit(w, mutate);
      const r = run(w);
      equal(r.status, 1, `${label} edited — expected a refusal:\n${r.stdout}${r.stderr}`);
      ok(r.stderr.includes(REFUSAL), r.stderr);
      ok(!existsSync(shimLog(w)), "nothing spawns for refused bytes");
      // The edited manifest is itself valid, so the refusal was the marker and
      // not a lint error — re-validating the new bytes lets the run through.
      equal(validate(w).status, 0, "the edited manifest is valid");
      equal(run(w).status, 0, "the new bytes run once validated");
    } finally {
      cleanup(w);
    }
  });
}

test("validated: a roster defaultEffort moving underneath does not refuse", () => {
  const w = world({ tasks: [{ id: "a", prompt: "x", provider: "claude", model: OTHER_MODEL }] });
  try {
    equal(validate(w).status, 0);
    const entry = readRosterEnvelope({ SWARM_HOME: w.home }).providers.claude;
    writeRosterEntry("claude", {
      ...entry,
      models: entry.models.map((m) => ({ ...m, defaultEffort: "low" })),
    }, { SWARM_HOME: w.home });
    const r = run(w);
    equal(r.status, 0, `the roster is not part of the key:\n${r.stdout}${r.stderr}`);
  } finally {
    cleanup(w);
  }
});

test("validated: validating in one cwd and running from another does not refuse", () => {
  const w = world();
  try {
    mkdirSync(join(w.dir, "sub"), { recursive: true });
    equal(validate(w).status, 0);
    const r = runCli(["run", w.path], { cwd: join(w.dir, "sub"), env: envOf(w) });
    equal(r.status, 0, `the invoking cwd is not part of the key:\n${r.stdout}${r.stderr}`);
  } finally {
    cleanup(w);
  }
});

test("validated: a new sibling run dir appearing between validate and run does not refuse", () => {
  const w = world({ resultsDir: null });
  try {
    const base = join(w.home, "runs", gitOut(["rev-parse", "--show-toplevel"], w.dir).replace(/[\\/:]/g, "-"));
    const v = validate(w);
    equal(v.status, 0, v.stderr);
    ok(v.stdout.includes("resultsDir: ") && v.stdout.trimEnd().endsWith("-1"), v.stdout);
    mkdirSync(join(base, "m-2"), { recursive: true });
    const r = run(w);
    equal(r.status, 0, `the default resultsDir is not part of the key:\n${r.stdout}${r.stderr}`);
    ok(existsSync(join(base, "m-2", "run.log")), "the run resumes into the newest sibling");
  } finally {
    cleanup(w);
  }
});

test("validated: --args with the same keys reordered does not refuse", () => {
  const w = world({ tasks: [{ id: "a", prompt: "{{args.a}} {{args.b}}", provider: "claude", model: MODEL }] });
  try {
    equal(validate(w, ["--args", '{"a":"1","b":"2"}']).status, 0);
    const r = run(w, ["--args", '{"b":"2","a":"1"}']);
    equal(r.status, 0, `args are canonicalised:\n${r.stdout}${r.stderr}`);
  } finally {
    cleanup(w);
  }
});

test("validated: --args with a changed value refuses", () => {
  const w = world({ tasks: [{ id: "a", prompt: "{{args.a}} {{args.b}}", provider: "claude", model: MODEL }] });
  try {
    equal(validate(w, ["--args", '{"a":"1","b":"2"}']).status, 0);
    const r = run(w, ["--args", '{"a":"1","b":"3"}']);
    equal(r.status, 1, `a different value is a different run:\n${r.stdout}${r.stderr}`);
    ok(r.stderr.includes(REFUSAL), r.stderr);
  } finally {
    cleanup(w);
  }
});

// A registry name is a lookup, so validating by name must cover running by name
// — the name is never a second key.
test("refusal: an args value holding an apostrophe still prints a pasteable command", () => {
  const w = world({ tasks: [{ id: "a", prompt: "{{args.a}}", provider: "claude", model: MODEL }] });
  try {
    const r = run(w, ["--args", `{"a":"it's"}`]);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(`--args '{"a":"it'\\''s"}'`), r.stderr);
  } finally {
    cleanup(w);
  }
});

test("validated: a manifest validated by registry name runs by that name", () => {
  const w = world();
  try {
    mkdirSync(join(w.home, "manifests"), { recursive: true });
    renameSync(w.path, join(w.home, "manifests", "named.json"));
    const v = runCli(["validate", "named"], { cwd: w.dir, env: envOf(w) });
    equal(v.status, 0, v.stderr);
    const r = runCli(["run", "named"], { cwd: w.dir, env: envOf(w) });
    equal(r.status, 0, `a name keys on its resolved file:\n${r.stdout}${r.stderr}`);
  } finally {
    cleanup(w);
  }
});

test("validated: editing a child manifest after validating makes run refuse", () => {
  const w = world({ tasks: [
    { id: "seed", prompt: "list", provider: "claude", model: MODEL },
    { id: "audit", manifest: "child.json", after: ["seed"] },
  ] });
  try {
    const child = join(w.dir, "child.json");
    writeFileSync(child, JSON.stringify({ tasks: [{ id: "c1", prompt: "child x", provider: "claude", model: MODEL }] }));
    equal(validate(w).status, 0);
    writeFileSync(child, JSON.stringify({ tasks: [{ id: "c1", prompt: "child y", provider: "claude", model: MODEL }] }));
    const r = run(w);
    equal(r.status, 1, `a child's bytes are part of the key:\n${r.stdout}${r.stderr}`);
    ok(r.stderr.includes(REFUSAL), r.stderr);
    equal(validate(w).status, 0);
    equal(run(w).status, 0, "the edited child runs once re-validated");
  } finally {
    cleanup(w);
  }
});

// The check sits after refuseLiveEngine, so a live engine keeps its own message
// even when the manifest was never validated at all.
test("validated: a live engine is refused with its own message, ahead of the validate check", () => {
  const w = world();
  try {
    mkdirSync(join(w.dir, "out"), { recursive: true });
    writeFileSync(join(w.dir, "out", "run.log"), JSON.stringify({
      ts: new Date().toISOString(), event: "run-start", pid: 4321, tasks: [{ id: "a", provider: "claude", model: MODEL }],
    }) + "\n");
    writeFileSync(join(w.dir, "out", "heartbeat"), `${new Date().toISOString()} 4321\n`);
    const r = run(w);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("already has a live engine"), r.stderr);
    ok(!r.stderr.includes(REFUSAL), `the live-engine refusal keeps priority: ${r.stderr}`);
    ok(!existsSync(shimLog(w)), "nothing spawns against a live engine");
  } finally {
    cleanup(w);
  }
});
