// Headroom: the :cloud weekly-allowance preflight, and the provenance rules that
// decide whether a meter reading may gate a run at all.
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, errorsOf, claudeTask } from "./helpers/manifest-fixtures.mjs";
import { getUsage, resetUsageMemo, saveCookie } from "../src/ollama-usage.mjs";

// ── headroom (:cloud weekly-allowance preflight) ──────────────────────────────

// Writes ~/.swarm/ollama-usage.json under a scratch SWARM_HOME so
// usageFromCache(cfg) reads a controlled reading, then restores the env var.
// `extra` merges into the cache file — lastError/lastErrorAt ride beside a
// reading exactly as a failed fetch leaves them.
function withHeadroom(dir, { weeklyPctUsed, ageMs = 0, extra = {} } = {}, fn) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "ollama-usage.json"), JSON.stringify({
    weeklyPctUsed,
    weeklyResetsAt: "2026-09-07T00:00:00Z",
    fetchedAt: Date.now() - ageMs,
    ...extra,
  }));
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = prevHome;
  }
}

// A reading that says it was fetched NOW is the only kind that may gate —
// callers that can fetch pass `await getUsage(cfg)`; tests inject a fake.
// Shape = a raw getUsage reading after readUsage (weeklyResetsAt -> resetsAt).
const liveHeadroom = (over = {}) => ({
  state: "ok", weeklyPctUsed: 42, resetsAt: "2026-09-12T08:00:00Z",
  provenance: "live", ...over,
});

test("headroom: M1 a LIVE exhausted meter rejects a :cloud seat, naming task, model, pct, reset, recast", () => {
  const dir = tmp();
  const prevTz = process.env.TZ;
  process.env.TZ = "Europe/London";
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    const errs = errorsOf(() => loadManifest(p, cfg, dir, {
      headroom: liveHeadroom({ state: "exhausted", weeklyPctUsed: 100, resetsAt: "2026-09-07T00:00:00Z" }),
    }));
    ok(errs.some((e) =>
      e.includes("find-diag") && e.includes("glm-5.3:cloud") && e.includes("100")
      && e.includes("Mon 7 Sep, 01:00") && /recast/i.test(e)
    ), errs.join("|"));
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M2 false-positive guard — Claude-only manifests are untouched by an exhausted meter", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [claudeTask({ provider: "claude", model: "claude-sonnet-5" }), claudeTask({ id: "b", provider: "claude", model: "claude-haiku-4-5-20251001" })] });
    const cfg = { ...CFG, provider: { allowedRoots: [], cloud: { ollama: { enabled: true } } } };
    withHeadroom(dir, { weeklyPctUsed: 100 }, () => {
      const plan = loadManifest(p, cfg, dir);
      equal(plan.tasks.length, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M3 false-positive guard — a LIVE healthy meter passes with no new output", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    const plan = loadManifest(p, cfg, dir, { headroom: liveHeadroom({ weeklyPctUsed: 42 }) });
    equal(plan.tasks[0].model, "glm-5.3:cloud");
    equal(plan.warnings, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M4 no configured cookie (unknown) does not fail a manifest", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    // cloud.ollama.enabled left off entirely -> usageFromCache is "unknown" with no cache file needed.
    const cfg = { ...CFG, provider: { allowedRoots: [dir] } };
    const plan = loadManifest(p, cfg, dir);
    equal(plan.tasks[0].model, "glm-5.3:cloud");
    equal(plan.warnings, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The default headroom (cache-only usageFromCache) carries provenance cached +
// the cache's recorded lastError — the warning carries the banner text, which
// is where `/!\ Cookie Expired` reaches validate output.
test("headroom: M5 a cached figure warns with its banner (last-seen stamp, the refresh command), does not fail", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    withHeadroom(dir, { weeklyPctUsed: 42, extra: { lastError: "expired-cookie", lastErrorAt: Date.now() - 86_400_000 } }, () => {
      const plan = loadManifest(p, cfg, dir);
      equal(plan.tasks[0].model, "glm-5.3:cloud");
      const w = plan.warnings?.find((w) => w.includes("find-diag"));
      ok(w, JSON.stringify(plan.warnings));
      ok(w.includes("/!\\ Cookie Expired"), w);
      ok(/last seen: \d{4}-\d{2}-\d{2}T/.test(w), "absolute UTC stamp, not an age");
      ok(w.includes("swarm ollama-usage"), w);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom: M7 governance is reported before the headroom rejection", () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    // allowedRoots empty -> cwd is outside every allowed root
    const cfg = { ...CFG, provider: { allowedRoots: [], cloud: { ollama: { enabled: true } } } };
    const errs = errorsOf(() => loadManifest(p, cfg, dir, {
      headroom: liveHeadroom({ state: "exhausted", weeklyPctUsed: 100, weeklyResetsAt: "2026-09-07T00:00:00Z" }),
    }));
    const govIdx = errs.findIndex((e) => e.includes("data governance"));
    const headroomIdx = errs.findIndex((e) => e.includes("weekly allowance is exhausted"));
    ok(govIdx !== -1 && headroomIdx !== -1, errs.join("|"));
    ok(govIdx < headroomIdx, `expected governance before headroom, got: ${errs.join("|")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Test 5 — the two 100% verdicts. A live one fails the run; a cached one (the
// cookie expired and the meter says 100 from 33h ago) succeeds, because the
// window may have reset since — the warning carries the banner instead.
test("headroom: T5 a live 100% fails; a cached 100% succeeds with the banner in its warning", async () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, { tasks: [{ id: "find-diag", prompt: "p", provider: "ollama", model: "glm-5.3:cloud" }] });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };

    const liveErrs = errorsOf(() => loadManifest(p, cfg, dir, {
      headroom: liveHeadroom({ state: "exhausted", weeklyPctUsed: 100, resetsAt: "R" }),
    }));
    ok(liveErrs.some((e) => e.includes("weekly allowance is exhausted")), liveErrs.join("|"));

    // Build the cached-100% reading the way production does: getUsage over a
    // redirecting fetch (expired cookie) and a 100% cache file.
    resetUsageMemo();
    const home = join(dir, "home2");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "ollama-usage.json"), JSON.stringify({
      weeklyPctUsed: 100, weeklyResetsAt: "2026-09-07T00:00:00Z", fetchedAt: Date.now() - 33 * 3_600_000,
    }));
    saveCookie(join(home, "ollama-cookie.json"), "expired");
    const redirect = async () => ({ status: 303, headers: { get: () => "https://ollama.com/signin" }, text: async () => "" });
    const headroom = await getUsage(cfg, { env: { SWARM_HOME: home }, _fetch: redirect });
    equal(headroom.provenance, "cached");
    equal(headroom.state, "exhausted");

    const plan = loadManifest(p, cfg, dir, { headroom });
    ok(plan.warnings?.some((w) => w.includes("find-diag") && w.includes("/!\\ Cookie Expired")), JSON.stringify(plan.warnings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Test 6 — one fetch per process across seats and stages: five :cloud seats
// read the meter once, and the second stage (a run re-reading after validate)
// reuses the memo rather than refetching.
test("headroom: T6 five :cloud seats fetch the meter exactly once — the memo carries validate into run", async () => {
  const dir = tmp();
  try {
    const p = writeManifest(dir, {
      tasks: ["a", "b", "c", "d", "e"].map((id) => ({ id, prompt: "p", provider: "ollama", model: "glm-5.3:cloud", cwd: dir })),
    });
    const cfg = { ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } };
    let fetches = 0;
    const counting = async () => { fetches++; return { status: 200, headers: { get: () => null }, text: async () => readFileSync(join(import.meta.dirname, "fixtures", "ollama-settings.html"), "utf8") }; };
    resetUsageMemo();
    saveCookie(join(dir, "ollama-cookie.json"), "tok");
    const headroom = await getUsage(cfg, { env: { SWARM_HOME: dir }, _fetch: counting });
    const validated = loadManifest(p, cfg, dir, { headroom });
    equal(validated.tasks.length, 5);
    const rerun = loadManifest(p, cfg, dir, { headroom: await getUsage(cfg, { env: { SWARM_HOME: dir }, _fetch: counting }) });
    equal(rerun.tasks.length, 5);
    equal(fetches, 1, "two stages, five seats, ONE fetch — the memo is the seam");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

