import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { loadManifest, matchDenylist, ValidationError } from "../src/manifest.mjs";
import { runCliAsync } from "./helpers/cli.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-deny-"));
}

// allowedRoots includes the manifest dir so governance stays quiet and the
// only error under test is the denylist's.
function cfg(dir, denylist) {
  return {
    provider: { allowedRoots: [dir] },
    concurrency: 4,
    timeoutMs: 600000,
    resultInlineCap: 4000,
    ...(denylist && { modelDenylist: denylist }),
  };
}

function writeManifest(dir, body) {
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify(body));
  return p;
}

function errorsOf(fn) {
  try {
    fn();
  } catch (e) {
    ok(e instanceof ValidationError, `expected ValidationError, got ${e}`);
    return e.errors;
  }
  throw new Error("expected loadManifest to throw");
}

// ── matchDenylist ─────────────────────────────────────────────────────────────

test("matchDenylist: case-insensitive substring, returns the matching entry", () => {
  equal(matchDenylist("Nemotron-3-Super:cloud", { modelDenylist: ["nemotron"] }), "nemotron");
  equal(matchDenylist("nemotron-3-super:cloud", { modelDenylist: ["NEMOTRON-3-SUPER:CLOUD"] }), "NEMOTRON-3-SUPER:CLOUD");
  equal(matchDenylist("glm-5.2:cloud", { modelDenylist: ["nemotron"] }), undefined);
});

test("matchDenylist: empty or missing denylist never matches", () => {
  equal(matchDenylist("nemotron-3-super:cloud", { modelDenylist: [] }), undefined);
  equal(matchDenylist("nemotron-3-super:cloud", {}), undefined);
});

// ── validation gate ───────────────────────────────────────────────────────────

test("task model on the denylist fails validation with a teaching error", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "v", prompt: "verify", model: "Nemotron-3-Super:cloud" }] });
    const errs = errorsOf(() => loadManifest(p, cfg(dir, ["nemotron"]), dir));
    ok(errs.some((e) => e.includes("Nemotron-3-Super:cloud") && e.includes("denylisted") && e.includes("nemotron") && e.includes("modelDenylist")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fallbackModel on the denylist fails validation", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "v", prompt: "verify", model: "haiku", fallbackModel: "nemotron-3-super:cloud" }] });
    const errs = errorsOf(() => loadManifest(p, cfg(dir, ["nemotron"]), dir));
    ok(errs.some((e) => e.includes("fallback") && e.includes("denylisted")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest model on the denylist fails validation", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: [{ id: "v", prompt: "verify", model: "haiku" }],
      digest: { model: "nemotron-3-super:cloud", instructions: "wrap" },
    });
    const errs = errorsOf(() => loadManifest(p, cfg(dir, ["nemotron"]), dir));
    ok(errs.some((e) => e.includes("digest") && e.includes("denylisted")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude aliases are not exempt from the denylist", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "v", prompt: "verify", model: "haiku" }] });
    const errs = errorsOf(() => loadManifest(p, cfg(dir, ["haiku"]), dir));
    ok(errs.some((e) => e.includes("denylisted")), errs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty denylist: the same manifest loads clean", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "v", prompt: "verify", model: "nemotron-3-super:cloud" }] });
    const plan = loadManifest(p, cfg(dir, []), dir);
    equal(plan.tasks[0].model, "nemotron-3-super:cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── roster listing ────────────────────────────────────────────────────────────

test("swarm models omits denylisted models from output and cache", async () => {
  const dir = tmp();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      recommendations: [
        { model: "glm-5.2:cloud", description: "Frontier open model" },
        { model: "nemotron-3-super:cloud", description: "Slow burn" },
      ],
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: { url: `http://127.0.0.1:${server.address().port}` },
      modelDenylist: ["nemotron"],
    }));
    const r = await runCliAsync(["models"], { cwd: dir, env: { SWARM_HOME: home } });
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("glm-5.2:cloud"), r.stdout);
    ok(!r.stdout.includes("nemotron"), r.stdout);
    ok(r.stdout.includes("haiku"), r.stdout);
    const cache = JSON.parse(readFileSync(join(home, "models-cache.json"), "utf8"));
    deepEqual(cache.models.map((m) => m.model), ["glm-5.2:cloud"]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
