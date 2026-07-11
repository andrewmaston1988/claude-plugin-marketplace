// N3 mechanical citation verification — all tests for src/citations.mjs and
// its enforceReturns/manifest/CLI integration live in this one file.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  isCitationSchema, citationPaths, extractCitations, verifyCitations, citationErrorLines,
} from "../src/citations.mjs";
import { runPlan } from "../src/scheduler.mjs";
import { readResult } from "../src/results.mjs";
import { loadManifest, effectivePlanDoc, ValidationError } from "../src/manifest.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";
import { runCli } from "./helpers/cli.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-cite-"));
}

const CITE_ITEM = {
  type: "object",
  required: ["file", "line", "quote"],
  properties: { file: { type: "string" }, line: { type: "integer" }, quote: { type: "string" } },
};
const SITES_SCHEMA = {
  type: "object",
  required: ["sites"],
  properties: { sites: { type: "array", items: CITE_ITEM } },
};

// ── detection ─────────────────────────────────────────────────────────────────

test("isCitationSchema: true for file/line/quote all declared and required", () => {
  equal(isCitationSchema(CITE_ITEM), true);
});

test("isCitationSchema: extra sibling properties do not defeat detection", () => {
  const s = {
    type: "object",
    required: ["file", "line", "quote", "status"],
    properties: { ...CITE_ITEM.properties, status: { enum: ["clean", "dirty"] } },
  };
  equal(isCitationSchema(s), true);
});

test("isCitationSchema: false when a field is missing from properties or required, or wrong-typed", () => {
  const noQuoteProp = {
    type: "object", required: ["file", "line", "quote"],
    properties: { file: { type: "string" }, line: { type: "integer" } },
  };
  equal(isCitationSchema(noQuoteProp), false);
  const notRequired = { ...CITE_ITEM, required: ["file", "line"] };
  equal(isCitationSchema(notRequired), false);
  const lineString = {
    type: "object", required: ["file", "line", "quote"],
    properties: { file: { type: "string" }, line: { type: "string" }, quote: { type: "string" } },
  };
  equal(isCitationSchema(lineString), false);
  equal(isCitationSchema({ type: "array" }), false);
});

test("isCitationSchema: line typed number (not just integer) is accepted", () => {
  const s = {
    type: "object", required: ["file", "line", "quote"],
    properties: { file: { type: "string" }, line: { type: "number" }, quote: { type: "string" } },
  };
  equal(isCitationSchema(s), true);
});

test("citationPaths: top level, under items, nested; [] when citation-free", () => {
  deepEqual(citationPaths(CITE_ITEM), ["output"]);
  deepEqual(citationPaths(SITES_SCHEMA), ["output.sites[]"]);
  const arr = { type: "array", items: CITE_ITEM };
  deepEqual(citationPaths(arr), ["output[]"]);
  deepEqual(citationPaths({ type: "object", properties: { n: { type: "number" } } }), []);
});

test("extractCitations: instances with array indices in path; empty arrays give none", () => {
  const value = {
    sites: [
      { file: "a.mjs", line: 3, quote: "const x = 1;" },
      { file: "b.mjs", line: 9, quote: "return y;" },
    ],
  };
  deepEqual(extractCitations(value, SITES_SCHEMA), [
    { path: "output.sites[0]", file: "a.mjs", line: 3, quote: "const x = 1;" },
    { path: "output.sites[1]", file: "b.mjs", line: 9, quote: "return y;" },
  ]);
  deepEqual(extractCitations({ sites: [] }, SITES_SCHEMA), []);
});

// ── verification ──────────────────────────────────────────────────────────────

// A real file on disk: the resolve/prefix logic under test is path-shaped.
function citeDir(lines) {
  const dir = tmp();
  writeFileSync(join(dir, "target.mjs"), lines.join("\n") + "\n");
  return dir;
}

test("verifyCitations: exact-line substring match — checked, no drift, no refutation", () => {
  const dir = citeDir(["line one", "const total = a + b;", "line three"]);
  try {
    const r = verifyCitations(
      [{ path: "output.sites[0]", file: "target.mjs", line: 2, quote: "total = a + b" }],
      { cwds: [dir] },
    );
    equal(r.checked, 1);
    deepEqual(r.drifted, []);
    deepEqual(r.refuted, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyCitations: whitespace-normalised match (re-indent, collapsed runs) passes", () => {
  const dir = citeDir(["    if (a   &&  b) {"]);
  try {
    const r = verifyCitations(
      [{ path: "output", file: "target.mjs", line: 1, quote: "if (a && b) {" }],
      { cwds: [dir] },
    );
    deepEqual(r.refuted, []);
    equal(r.checked, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyCitations: multi-line quote matches on its first line only", () => {
  const dir = citeDir(["alpha();", "beta();"]);
  try {
    const r = verifyCitations(
      [{ path: "output", file: "target.mjs", line: 1, quote: "alpha();\nsomething else entirely" }],
      { cwds: [dir] },
    );
    deepEqual(r.refuted, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyCitations: off-by-one and off-by-two drift with matched line recorded; off-by-three refuted", () => {
  const lines = ["pad", "pad", "pad", "const needle = 42;", "pad", "pad", "pad"];
  const dir = citeDir(lines);
  try {
    const off1 = verifyCitations([{ path: "p1", file: "target.mjs", line: 5, quote: "needle = 42" }], { cwds: [dir] });
    deepEqual(off1.refuted, []);
    equal(off1.drifted.length, 1);
    equal(off1.drifted[0].matchedLine, 4);

    const off2 = verifyCitations([{ path: "p2", file: "target.mjs", line: 6, quote: "needle = 42" }], { cwds: [dir] });
    deepEqual(off2.refuted, []);
    equal(off2.drifted[0].matchedLine, 4);

    const off3 = verifyCitations([{ path: "p3", file: "target.mjs", line: 7, quote: "needle = 42" }], { cwds: [dir] });
    equal(off3.refuted.length, 1);
    ok(/searched ±2/.test(off3.refuted[0].reason), off3.refuted[0].reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyCitations: quote absent anywhere in window — refuted, reason names file and line", () => {
  const dir = citeDir(["nothing to see"]);
  try {
    const r = verifyCitations(
      [{ path: "output", file: "target.mjs", line: 1, quote: "const ghost = true;" }],
      { cwds: [dir] },
    );
    equal(r.refuted.length, 1);
    ok(/quote not found/.test(r.refuted[0].reason), r.refuted[0].reason);
    ok(r.refuted[0].reason.includes("target.mjs"), r.refuted[0].reason);
    ok(r.refuted[0].reason.includes("1"), r.refuted[0].reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyCitations: missing file, line past EOF, and out-of-cwd paths are refuted", () => {
  const dir = citeDir(["only line"]);
  try {
    const missing = verifyCitations([{ path: "a", file: "ghost.mjs", line: 1, quote: "x" }], { cwds: [dir] });
    ok(/does not exist/.test(missing.refuted[0].reason), missing.refuted[0].reason);

    const pastEof = verifyCitations([{ path: "b", file: "target.mjs", line: 12, quote: "x" }], { cwds: [dir] });
    ok(/file has 1 line/.test(pastEof.refuted[0].reason), pastEof.refuted[0].reason);

    const escape = verifyCitations([{ path: "c", file: "../../outside.txt", line: 1, quote: "x" }], { cwds: [dir] });
    ok(/outside the task's cwd/.test(escape.refuted[0].reason), escape.refuted[0].reason);

    const abs = verifyCitations([{ path: "d", file: join(tmpdir(), "elsewhere.txt"), line: 1, quote: "x" }], { cwds: [dir] });
    ok(/outside the task's cwd/.test(abs.refuted[0].reason), abs.refuted[0].reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyCitations: file found under the second cwd when absent from the first", () => {
  const wt = tmp();
  const orig = tmp();
  try {
    writeFileSync(join(orig, "only-here.mjs"), "the real content\n");
    const r = verifyCitations(
      [{ path: "output", file: "only-here.mjs", line: 1, quote: "real content" }],
      { cwds: [wt, orig] },
    );
    deepEqual(r.refuted, []);
    equal(r.checked, 1);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(orig, { recursive: true, force: true });
  }
});

test("citationErrorLines: caps at 10 with an …and-N-more tail", () => {
  const refuted = Array.from({ length: 14 }, (_, i) => ({
    path: `output.sites[${i}]`, file: "f.mjs", line: i + 1, quote: "q", reason: "quote not found",
  }));
  const lines = citationErrorLines(refuted);
  equal(lines.length, 11);
  ok(lines[10].includes("4 more"), lines[10]);
});

// ── enforceReturns integration (runPlan + fake io) ────────────────────────────

const CFG = {
  provider: { mode: "env", url: "http://127.0.0.1:1", authToken: "ollama", allowedRoots: [] },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
  worktreeBranchPrefix: "swarm/",
};

const streamOut = (text, sid) => [
  ...(sid ? [JSON.stringify({ type: "system", subtype: "init", session_id: sid })] : []),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 100, output_tokens: 10 } }),
].join("\n") + "\n";

function task(id, cwd, over = {}) {
  return {
    id, prompt: `do ${id}`, model: "haiku", allowedTools: "Read,Grep,Glob",
    cwd, originalCwd: cwd, scratchRedirect: false, timeoutMs: 5000, after: [],
    ...over,
  };
}

function plan(dir, tasks) {
  return { cwd: dir, resultsDir: join(dir, "run"), concurrency: 4, tasks, goal: "" };
}

const site = (file, line, quote) => ({ file, line, quote });

test("integration: verified citations — leaf ok, citations field, run.log event", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.mjs"), "one\nconst k = 7;\nthree\n");
    const out = JSON.stringify({ sites: [site("src.mjs", 2, "const k = 7;")] });
    const spawn = fakeSpawnFactory(() => ({ output: streamOut(out, "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);

    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    deepEqual(res.citations, { checked: 1, drifted: 0 });
    equal(res.citationErrors, undefined);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(logLines.some((l) => l.event === "citations" && l.id === "a" && l.checked === 1 && l.refuted === 0),
      "expected citations event in run.log");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: fabricated citation — teaching re-ask, corrected output passes", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.mjs"), "one\nconst k = 7;\nthree\n");
    const bad = JSON.stringify({ sites: [site("src.mjs", 2, "const fabricated = 99;")] });
    const good = JSON.stringify({ sites: [site("src.mjs", 2, "const k = 7;")] });
    const spawn = fakeSpawnFactory((call, i) => ({ output: streamOut(i === 0 ? bad : good, `s-${i + 1}`) }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);

    equal(spawn.calls.length, 2);
    const rp = promptOf(spawn.calls[1]);
    ok(rp.includes("output.sites[0]"), rp);
    ok(rp.includes("src.mjs"), rp);
    ok(/correct the citation or withdraw the claim/.test(rp), rp);

    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.schemaRetried, true);
    deepEqual(res.citations, { checked: 1, drifted: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: still-fabricated after re-ask — failed with citationErrors", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.mjs"), "one\n");
    const bad = JSON.stringify({ sites: [site("src.mjs", 1, "const ghost = 1;")] });
    const spawn = fakeSpawnFactory(() => ({ output: streamOut(bad, "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { returns: SITES_SCHEMA })]);
    const r = await runPlan(p, CFG, io);

    equal(spawn.calls.length, 2);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    ok(Array.isArray(res.citationErrors) && res.citationErrors.length === 1, JSON.stringify(res.citationErrors));
    equal(r.summary.tasks.find((t) => t.id === "a").state, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: schema errors and citation errors share ONE corrective turn", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.mjs"), "const k = 7;\n");
    // 1st output: schema-invalid. 2nd output: schema-valid but fabricated.
    // Total spawns must stay 2 — the correction budget is one turn, shared.
    const spawn = fakeSpawnFactory((call, i) => i === 0
      ? { output: streamOut(JSON.stringify(["not the shape"]), "s-1") }
      : { output: streamOut(JSON.stringify({ sites: [site("src.mjs", 1, "const ghost;")] }), "s-2") });
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { returns: SITES_SCHEMA })]);
    await runPlan(p, CFG, io);

    equal(spawn.calls.length, 2);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, false);
    ok(res.citationErrors, JSON.stringify(res));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: verifyCitations false skips verification entirely", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.mjs"), "one\n");
    const fabricated = JSON.stringify({ sites: [site("src.mjs", 1, "const ghost = 1;")] });
    const spawn = fakeSpawnFactory(() => ({ output: streamOut(fabricated, "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { returns: SITES_SCHEMA, verifyCitations: false })]);
    await runPlan(p, CFG, io);

    equal(spawn.calls.length, 1);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.citations, undefined);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(!logLines.some((l) => l.event === "citations"), "no citations event expected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: citation-free returns schema — zero behaviour change", async () => {
  const dir = tmp();
  try {
    const plain = { type: "object", required: ["sites"], properties: { sites: { type: "array" } } };
    const spawn = fakeSpawnFactory(() => ({ output: streamOut(JSON.stringify({ sites: [1] }), "s-1") }));
    const io = makeIo(spawn);
    const p = plan(dir, [task("a", dir, { returns: plain })]);
    await runPlan(p, CFG, io);
    const res = readResult(p.resultsDir, "a");
    equal(res.ok, true);
    equal(res.citations, undefined);
    const logLines = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(!logLines.some((l) => l.event === "citations"), "no citations event expected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── manifest + CLI ────────────────────────────────────────────────────────────

function errorsOf(fn) {
  try { fn(); return []; } catch (e) {
    if (e instanceof ValidationError) return e.errors;
    throw e;
  }
}

test("manifest: non-boolean verifyCitations is a teaching error", () => {
  const dir = tmp();
  try {
    const p = join(dir, "m.json");
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "a", prompt: "x", model: "haiku", returns: SITES_SCHEMA, verifyCitations: "yes" }],
    }));
    const errs = errorsOf(() => loadManifest(p, CFG, dir));
    // must be the boolean teaching error, not the generic unknown-key error
    ok(errs.some((e) => e.includes("verifyCitations") && /true or false/.test(e)), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("manifest: effectivePlanDoc round-trips verifyCitations false", () => {
  const dir = tmp();
  try {
    const p = join(dir, "m.json");
    writeFileSync(p, JSON.stringify({
      tasks: [{ id: "a", prompt: "x", model: "haiku", returns: SITES_SCHEMA, verifyCitations: false }],
    }));
    const plan = loadManifest(p, CFG, dir);
    const doc = effectivePlanDoc(plan);
    equal(doc.tasks[0].verifyCitations, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validate CLI: announces mechanical citation verification; opt-out omits the task", () => {
  const dir = tmp();
  try {
    const p = join(dir, "m.json");
    writeFileSync(p, JSON.stringify({
      tasks: [
        { id: "find", prompt: "x", model: "haiku", returns: SITES_SCHEMA },
        { id: "loose", prompt: "y", model: "haiku", returns: SITES_SCHEMA, verifyCitations: false },
      ],
    }));
    const r = runCli(["validate", p], { cwd: dir, env: { SWARM_HOME: join(dir, "home") } });
    equal(r.status, 0, r.stderr);
    const line = r.stdout.split("\n").find((l) => l.includes("citations verified mechanically"));
    ok(line, r.stdout);
    ok(line.includes("find"), line);
    ok(!line.includes("loose"), line);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
