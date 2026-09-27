import { test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runPlan } from "../src/scheduler.mjs";
import { fakeSpawnFactory, makeIo, promptOf } from "./helpers/fake-io.mjs";
import { CFG, tmp, task, plan, computeTask, childPlanOf } from "./helpers/scheduler-fixtures.mjs";

test("wave seating: every ready finder launches before its interleaved verifier", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => ({ delayMs: promptOf(call).startsWith("do v") ? 20 : 5, output: "ok" }));
    const p = plan(dir, [
      task("f1"), task("v1", { after: ["f1"] }),
      task("f2"), task("v2", { after: ["f2"] }),
      task("f3"), task("v3", { after: ["f3"] }),
      task("f4"), task("v4", { after: ["f4"] }),
    ], { concurrency: 2 });
    await runPlan(p, CFG, makeIo(spawn));
    const launched = spawn.calls.map((call) => promptOf(call).slice(3));
    const lastFinder = Math.max(...["f1", "f2", "f3", "f4"].map((id) => launched.indexOf(id)));
    const firstVerifier = Math.min(...["v1", "v2", "v3", "v4"].map((id) => launched.indexOf(id)));
    ok(lastFinder < firstVerifier, `expected all finders before any verifier; got ${launched.join(", ")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("inline compute settles before the ready leaves launch", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 40, output: "ok" }));
    const p = plan(dir, [task("f1"), task("f2"), computeTask("src", "length('x')", [])], { concurrency: 2 });
    await runPlan(p, CFG, makeIo(spawn));
    const events = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const computed = events.findIndex((event) => event.id === "src" && event.state === "ok");
    const firstLaunch = events.findIndex((event) => event.state === "running" && ["f1", "f2"].includes(event.id));
    ok(computed >= 0 && computed < firstLaunch, `expected inline settlement before leaf launches; event order ${events.map((e) => `${e.id}:${e.event || e.state}`).join(", ")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forEach clone yields a freed seat to an earlier wave leaf", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "do src"
      ? { delayMs: 5, output: '["x"]' }
      : { delayMs: promptOf(call) === "do f1" ? 50 : 5, output: "ok" });
    const p = plan(dir, [
      task("src"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "", maxItems: 2 } }),
      task("f1"), task("f2"),
    ], { concurrency: 2 });
    await runPlan(p, CFG, makeIo(spawn));
    const launches = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).filter((event) => event.state === "running").map((event) => event.id);
    ok(launches.indexOf("f2") < launches.indexOf("fix[0]"), `expected earlier wave f2 before fix clone; got ${launches.join(", ")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wave seating: a manifest node's root child sits in the node's wave, behind earlier-wave leaves", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory(() => ({ delayMs: 5, output: "ok" }));
    const node = task("m", { model: "manifest", prompt: "", after: ["x"], childPlan: childPlanOf(task("c1")) });
    const p = plan(dir, [task("x"), node, task("y"), task("z")], { concurrency: 1 });
    await runPlan(p, CFG, makeIo(spawn));
    const launched = spawn.calls.map((call) => promptOf(call).slice(3));
    deepEqual(launched, ["x", "y", "z", "c1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wave seating: a manifest node's forEach child keeps the node's wave when it expands", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => ({ delayMs: 5, output: promptOf(call) === "do src" ? '["a","b"]' : "ok" }));
    const child = task("c1", { after: [], forEach: { from: "src", path: "", maxItems: 2 } });
    const node = task("m", { model: "manifest", prompt: "", after: ["x", "src"], childPlan: childPlanOf(child) });
    const p = plan(dir, [task("x"), task("src"), node, task("y"), task("z")], { concurrency: 1 });
    await runPlan(p, CFG, makeIo(spawn));
    const launched = spawn.calls.map((call) => promptOf(call).slice(3));
    deepEqual(launched, ["x", "src", "y", "z", "c1", "c1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wave seating: a forEach behind a full wave still expands in the same pass", async () => {
  const dir = tmp();
  try {
    const spawn = fakeSpawnFactory((call) => promptOf(call) === "do src"
      ? { delayMs: 5, output: '["a"]' }
      : { delayMs: ["do hold", "do w"].includes(promptOf(call)) ? 60 : 5, output: "ok" });
    const p = plan(dir, [
      task("src"), task("hold"), task("w"),
      task("fix", { after: ["src"], forEach: { from: "src", path: "", maxItems: 1 } }),
    ], { concurrency: 2 });
    await runPlan(p, CFG, makeIo(spawn));
    const events = readFileSync(join(p.resultsDir, "run.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const expanded = events.findIndex((event) => event.event === "expand" && event.id === "fix");
    const srcDone = events.findIndex((event) => event.id === "src" && event.state === "ok");
    const firstHeldDone = events.findIndex((event) => ["hold", "w"].includes(event.id) && event.state === "ok");
    ok(srcDone >= 0 && expanded > srcDone && expanded < firstHeldDone,
      `expected fix to expand while hold and w held every seat; event order ${events.map((e) => `${e.id}:${e.event || e.state}`).join(", ")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
