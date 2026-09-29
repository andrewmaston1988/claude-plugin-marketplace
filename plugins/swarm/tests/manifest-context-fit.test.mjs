// validate refuses a seat whose estimated mustRead reads exceed half its model's
// declared context window. Driven through loadManifest with a temp dir and an
// injected roster; boundary pins use the literals 4 bytes/token and 0.5.
import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./helpers/repo-io.mjs";
import { CFG, writeManifest, tmp, claudeTask } from "./helpers/manifest-fixtures.mjs";

const CACHE = [
  { provider: "ollama", model: "small:cloud", contextLength: 131072 },
  { provider: "ollama", model: "mid:cloud", contextLength: 100000 },
  { provider: "ollama", model: "big:cloud", contextLength: 1048576 },
  { provider: "ollama", model: "nowin:cloud" },
  { provider: "claude", model: "claude-haiku-4-5-20251001" },
];
const HEADROOM = { state: "unknown", provenance: "cache" };
const KB300 = 300000;

const cfgFor = (dir) => ({ ...CFG, provider: { allowedRoots: [dir], cloud: { ollama: { enabled: true } } } });
const seat = (model, over = {}) => ({ id: "x", prompt: "p", provider: "ollama", model, ...over });
const isFit = (e) => e.includes("mustRead is ~") || e.includes("mustRead is ≥");

// Loads the manifest; returns the context-fit errors (empty when it loads clean).
// Any other validation error fails the test so a broken fixture cannot pass silently.
function fit(dir, manifest, cache = CACHE) {
  const p = writeManifest(dir, manifest);
  try {
    loadManifest(p, cfgFor(dir), dir, { cache, headroom: HEADROOM });
    return [];
  } catch (e) {
    ok(Array.isArray(e.errors), String(e));
    const other = e.errors.filter((x) => !isFit(x));
    equal(other.length, 0, `unrelated errors: ${other.join("\n")}`);
    return e.errors;
  }
}

const lines = (n) => Array.from({ length: n }, () => "x".repeat(99) + "\n").join("");

test("context-fit: refuses over-budget reads, naming task, model, window, estimate, fix", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(367999));
  const errs = fit(dir, { tasks: [seat("small:cloud", { mustRead: ["big.txt"] })] });
  equal(errs.length, 1);
  const e = errs[0];
  ok(e.startsWith("task 'x': seats 'small:cloud' (131k ctx), but its mustRead is ~92k tokens (368 KB)"), e);
  ok(e.includes("over the 50% budget (65.5k)"), e);
  ok(e.includes("'swarm models' prints ctx per row") && e.includes("split the reads across more lanes"), e);
});

test("context-fit: the same reads on a large-window seat pass", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(400000));
  deepEqual(fit(dir, { tasks: [seat("big:cloud", { mustRead: ["big.txt"] })] }), []);
});

test("context-fit: boundary pins 4 bytes/token and 50% (ctx 100000 -> 200000 bytes)", () => {
  const dir = tmp();
  writeFileSync(join(dir, "under.txt"), "a".repeat(199999)); // + 1-byte prompt = 200000 bytes = 50000 tokens
  writeFileSync(join(dir, "over.txt"), "a".repeat(200000)); // 200001 bytes -> 50000.25 tokens
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: ["under.txt"] })] }), []);
  equal(fit(dir, { tasks: [seat("mid:cloud", { mustRead: ["over.txt"] })] }).length, 1);
});

test("context-fit: a seat whose roster row has no contextLength passes whatever the reads", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(2000000));
  deepEqual(fit(dir, { tasks: [seat("nowin:cloud", { mustRead: ["big.txt"] })] }), []);
  deepEqual(fit(dir, { tasks: [claudeTask({ id: "x", mustRead: ["big.txt"] })] }), []);
});

test("context-fit: a {path, lines} entry counts only its lines' bytes", () => {
  const dir = tmp();
  writeFileSync(join(dir, "huge.txt"), lines(3000)); // 300 KB whole
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ path: "huge.txt", lines: [[1, 10]] }] })] }), []);
  equal(fit(dir, { tasks: [seat("mid:cloud", { mustRead: ["huge.txt"] })] }).length, 1);
});

test("context-fit: an {index, lane} entry counts only that lane's files", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.txt"), "a".repeat(KB300));
  writeFileSync(join(dir, "b.txt"), "b".repeat(10));
  writeFileSync(join(dir, "idx.json"), JSON.stringify({ entries: ["a.txt", "b.txt"], lanes: [[0], [1]] }));
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ index: "idx.json", lane: 1 }] })] }), []);
  equal(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ index: "idx.json", lane: 0 }] })] }).length, 1);
});

test("context-fit: a task's relative mustRead is sized from its own cwd, not the loader's", () => {
  const dir = tmp();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "big.txt"), "a".repeat(KB300)); // same name at the loader cwd
  writeFileSync(join(dir, "sub", "big.txt"), "a".repeat(10));
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { cwd: "sub", mustRead: ["big.txt"] })] }), []);
});

test("context-fit: overlapping ranges, and a path named twice, count once", () => {
  const dir = tmp();
  writeFileSync(join(dir, "f.txt"), lines(3000)); // 100 bytes/line; budget ~2000 lines
  // merged 1..1800 = 180 KB; a naive sum is 2401 lines
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ path: "f.txt", lines: [[1, 1200], [600, 1800]] }] })] }), []);
  // the same 150 KB range named twice; a naive sum is 300 KB
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ path: "f.txt", lines: [[1, 1500]] }, { path: "f.txt", lines: [[1, 1500]] }] })] }), []);
});

test("context-fit: a range past EOF is clamped, never NaN", () => {
  const dir = tmp();
  writeFileSync(join(dir, "small.txt"), lines(100));
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ path: "small.txt", lines: [[1, 1e9]] }] })] }), []);
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ path: "small.txt", lines: [[500, 1e9]] }] })] }), []);
});

test("context-fit: line terminators are counted (CRLF file, whole and ranged agree)", () => {
  const dir = tmp();
  writeFileSync(join(dir, "crlf.txt"), ("x".repeat(98) + "\r\n").repeat(2100)); // 210000 bytes
  equal(fit(dir, { tasks: [seat("mid:cloud", { mustRead: ["crlf.txt"] })] }).length, 1);
  equal(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ path: "crlf.txt", lines: [[1, 2100]] }] })] }).length, 1);
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: [{ path: "crlf.txt", lines: [[1, 1900]] }] })] }), []);
});

test("context-fit: resultPath entries are skipped and the estimate prints as a floor; nothing sizeable passes", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(KB300));
  const seed = claudeTask({ id: "seed" });
  const errs = fit(dir, { tasks: [seed, seat("mid:cloud", { after: ["seed"], mustRead: ["{{resultPath:seed}}", "big.txt"] })] });
  equal(errs.length, 1);
  ok(errs[0].includes("mustRead is ≥75k tokens"), errs[0]);
  deepEqual(fit(dir, { tasks: [seed, seat("mid:cloud", { after: ["seed"], mustRead: ["{{resultPath:seed}}"] })] }), []);
});

test("context-fit: a fallback seat is checked against its own window, labelled '<id> fallback'", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(KB300));
  const errs = fit(dir, { tasks: [seat("big:cloud", { fallbackModel: "small:cloud", fallbackProvider: "ollama", mustRead: ["big.txt"] })] });
  equal(errs.length, 1);
  ok(errs[0].startsWith("task 'x' fallback: seats 'small:cloud' (131k ctx)"), errs[0]);
});

test("context-fit: a leaf in a child manifest is checked", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(KB300));
  writeFileSync(join(dir, "child.json"), JSON.stringify({ tasks: [seat("mid:cloud", { mustRead: ["big.txt"] })] }));
  const errs = fit(dir, { tasks: [{ id: "audit", manifest: "child.json" }] });
  equal(errs.length, 1);
  ok(errs[0].startsWith("task 'audit' -> child 'x': seats 'mid:cloud' (100k ctx)"), errs[0]);
});

test("context-fit: the prompt's own bytes count toward the estimate", () => {
  const dir = tmp();
  writeFileSync(join(dir, "f.txt"), "a".repeat(199990));
  deepEqual(fit(dir, { tasks: [seat("mid:cloud", { mustRead: ["f.txt"] })] }), []);
  equal(fit(dir, { tasks: [seat("mid:cloud", { prompt: "x".repeat(20), mustRead: ["f.txt"] })] }).length, 1);
});

// A :cloud leaf runs through the claude CLI, which keeps its default 200k window unless the
// task opts into "1m" — the catalogue's 1M figure is not the window that leaf gets.
const CLI_CACHE = [...CACHE, { provider: "ollama", model: "wide:cloud", contextLength: 1048576, runner: "claude" }];

test("context-fit: a claude-runner seat is budgeted at 200k unless contextWindow is 1m", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(400000)); // 100k tokens: over 50% of 200k, under 50% of 1M
  const errs = fit(dir, { tasks: [seat("wide:cloud", { mustRead: ["big.txt"] })] }, CLI_CACHE);
  equal(errs.length, 1);
  ok(errs[0].includes("(200k ctx"), errs[0]);
  ok(errs[0].includes('"contextWindow": "1m"'), errs[0]);
  deepEqual(fit(dir, { tasks: [seat("wide:cloud", { contextWindow: "1m", mustRead: ["big.txt"] })] }, CLI_CACHE), []);
});

test("context-fit: a worktree leaf's estimate is a floor — it reads the tree cut at dispatch", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(KB300));
  const errs = fit(dir, { tasks: [seat("mid:cloud", { allowedTools: "Read,Edit,Bash", mustRead: ["big.txt"] })] });
  equal(errs.length, 1);
  ok(errs[0].includes("mustRead is ≥"), errs[0]);
});

test("context-fit: a model name with surrounding whitespace still finds its roster row", () => {
  const dir = tmp();
  writeFileSync(join(dir, "big.txt"), "a".repeat(KB300));
  equal(fit(dir, { tasks: [seat(" mid:cloud ", { mustRead: ["big.txt"] })] }).length, 1);
});

test("context-fit: a sub-2000-token budget still prints a number", () => {
  const dir = tmp();
  writeFileSync(join(dir, "f.txt"), "a".repeat(20000));
  const errs = fit(dir, { tasks: [seat("tiny:cloud", { mustRead: ["f.txt"] })] }, [...CACHE, { provider: "ollama", model: "tiny:cloud", contextLength: 3000 }]);
  equal(errs.length, 1);
  ok(errs[0].includes("budget (1.5k)"), errs[0]);
});
