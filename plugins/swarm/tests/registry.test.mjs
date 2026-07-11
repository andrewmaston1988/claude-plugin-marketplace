import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isPathRef, resolveRef, listManifests } from "../src/registry.mjs";
import { ValidationError } from "../src/manifest.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-reg-"));
}

// cwd + SWARM_HOME pair with both registry dirs created; save() drops a
// manifest into either scope.
function scaffold() {
  const cwd = tmp();
  const home = tmp();
  const localDir = join(cwd, ".swarm", "manifests");
  const globalDir = join(home, "manifests");
  mkdirSync(localDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  const env = { SWARM_HOME: home };
  const save = (scope, name, body = { goal: `${name} goal`, tasks: [{ id: "a", prompt: "x", model: "haiku" }] }) => {
    const p = join(scope === "local" ? localDir : globalDir, `${name}.json`);
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };
  const cleanup = () => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return { cwd, home, localDir, globalDir, env, save, cleanup };
}

function errorsOf(fn) {
  try {
    fn();
  } catch (e) {
    ok(e instanceof ValidationError, `expected ValidationError, got ${e}`);
    return e.errors;
  }
  throw new Error("expected a throw");
}

test("ref classification: separator or .json suffix = path, else registry name", () => {
  ok(isPathRef("audits/x.json"));
  ok(isPathRef("./x"));
  ok(isPathRef("x.JSON"));
  ok(isPathRef("..\\win\\style.json"));
  ok(!isPathRef("code-review"));
  ok(!isPathRef("gap.audit-2"));
});

test("path refs resolve against cwd and never probe the registry", () => {
  const cwd = tmp(); // no .swarm, no SWARM_HOME dirs — must not matter
  try {
    const r = resolveRef("./sweep.json", cwd, { SWARM_HOME: join(cwd, "nonexistent-home") });
    equal(r.source, "path");
    equal(r.path, resolve(cwd, "sweep.json"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid names die with a charset teaching error", () => {
  const s = scaffold();
  try {
    for (const bad of ["bad name!", "-leading", ".hidden"]) {
      const errs = errorsOf(() => resolveRef(bad, s.cwd, s.env));
      ok(errs.some((e) => e.includes("A-Za-z0-9")), `${bad}: ${errs.join("|")}`);
    }
  } finally {
    s.cleanup();
  }
});

test("name resolves in exactly one scope: global", () => {
  const s = scaffold();
  try {
    const p = s.save("global", "code-review");
    const r = resolveRef("code-review", s.cwd, s.env);
    equal(r.path, p);
    equal(r.source, "global");
  } finally {
    s.cleanup();
  }
});

test("name resolves in exactly one scope: local", () => {
  const s = scaffold();
  try {
    const p = s.save("local", "repo-audit");
    const r = resolveRef("repo-audit", s.cwd, s.env);
    equal(r.path, p);
    equal(r.source, "local");
  } finally {
    s.cleanup();
  }
});

test("collision (name in both scopes) fails loudly with both paths — never picks one", () => {
  const s = scaffold();
  try {
    const pl = s.save("local", "dup");
    const pg = s.save("global", "dup");
    const errs = errorsOf(() => resolveRef("dup", s.cwd, s.env));
    const msg = errs.join("\n");
    ok(msg.includes(pl), msg);
    ok(msg.includes(pg), msg);
    ok(/disambiguate/i.test(msg), msg);
  } finally {
    s.cleanup();
  }
});

test("unknown name lists what IS saved; empty registry says so", () => {
  const s = scaffold();
  try {
    s.save("global", "code-review");
    s.save("local", "repo-audit");
    const errs = errorsOf(() => resolveRef("nope", s.cwd, s.env));
    const msg = errs.join("\n");
    ok(msg.includes("code-review"), msg);
    ok(msg.includes("repo-audit"), msg);
  } finally {
    s.cleanup();
  }
});

test("missing registry dirs entirely: readable not-found error, no fs crash", () => {
  const cwd = tmp();
  try {
    const errs = errorsOf(() => resolveRef("ghost", cwd, { SWARM_HOME: join(cwd, "no-home") }));
    ok(errs.some((e) => /none saved/i.test(e)), errs.join("|"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("listManifests: merged, name-sorted, goal peeked, collisions flagged, junk tolerated", () => {
  const s = scaffold();
  try {
    s.save("local", "b-local");
    s.save("global", "a-global");
    s.save("global", "broken", "not json at all {{");
    s.save("global", "goalless", { tasks: [{ id: "a", prompt: "x", model: "haiku" }] });
    s.save("local", "dup");
    s.save("global", "dup");
    const entries = listManifests(s.cwd, s.env);
    deepSortedCheck(entries);
    const byName = (n, scope) => entries.find((e) => e.name === n && (!scope || e.scope === scope));
    equal(byName("a-global").scope, "global");
    equal(byName("a-global").goal, "a-global goal");
    equal(byName("b-local").scope, "local");
    equal(byName("broken").goal, "(unreadable)");
    equal(byName("goalless").goal, "");
    ok(byName("dup", "local") && byName("dup", "global"), "both dup entries listed");
    ok(byName("dup", "local").collision === true && byName("dup", "global").collision === true, "collision flagged");
    ok(!byName("a-global").collision, "non-colliding entries unflagged");
  } finally {
    s.cleanup();
  }
});

function deepSortedCheck(entries) {
  const names = entries.map((e) => e.name);
  const sorted = [...names].sort();
  equal(names.join(","), sorted.join(","), "entries name-sorted");
}

test("listManifests: both dirs missing = empty list, no throw", () => {
  const cwd = tmp();
  try {
    const entries = listManifests(cwd, { SWARM_HOME: join(cwd, "no-home") });
    equal(entries.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
