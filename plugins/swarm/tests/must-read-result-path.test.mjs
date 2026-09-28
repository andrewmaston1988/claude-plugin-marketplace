// A prompt that hands a leaf {{resultPath:<dep>}} hands it an absolute path and
// nothing else proves the leaf opened it — the rule lives in manifest-must-read.mjs
// and is exercised through the same validate entry manifest.test.mjs uses.
import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./helpers/repo-io.mjs";
import { ValidationError } from "../src/manifest.mjs";
import { validateResultPathReads } from "../src/manifest-must-read.mjs";
import { CFG, writeManifest, tmp, claudeTask } from "./helpers/manifest-fixtures.mjs";

// The one message the rule emits, and the three things it must carry.
const RULE = "mustRead never names it";
const ruleErrors = (errs) => errs.filter((e) => e.includes(RULE));

const find = (over = {}) => claudeTask({ id: "find", prompt: "find the sites", ...over });
const verify = (prompt, over = {}) => claudeTask({ id: "verify", prompt, after: ["find"], ...over });
const load = (dir, tasks, cfg = CFG, name = "plan.json") => loadManifest(writeManifest(dir, { tasks }, name), cfg, dir);
// The "passes" rows need the empty case too, which errorsOf cannot express.
const loadErrs = (dir, tasks, cfg = CFG, name = "plan.json") => {
  try {
    load(dir, tasks, cfg, name);
    return [];
  } catch (e) {
    ok(e instanceof ValidationError, `expected ValidationError, got ${e}`);
    return e.errors;
  }
};

test("prompt reads {{resultPath:find}} with no mustRead → error naming the task, the token, and the fix", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [find(), verify("Read {{resultPath:find}} and check every claim.")]);
    const e = ruleErrors(errs)[0];
    ok(e, errs.join("\n"));
    ok(e.startsWith("task 'verify': "), e);
    ok(e.includes("{{resultPath:find}}"), e);
    ok(e.includes(`"mustRead": ["{{resultPath:find}}"]`), e);
    equal(ruleErrors(errs).length, 1, errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a mustRead naming only a different file still fails", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [find(), verify("Read {{resultPath:find}}.", { mustRead: ["README.md"] })]);
    ok(ruleErrors(errs).some((e) => e.includes("{{resultPath:find}}")), errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: [\"{{resultPath:find}}\"] passes", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [find(), verify("Read {{resultPath:find}}.", { mustRead: ["{{resultPath:find}}"] })]);
    equal(ruleErrors(errs).length, 0, errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mustRead: [{\"path\": \"{{resultPath:find}}\", \"lines\": [[1, 50]]}] passes", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [find(), verify("Read {{resultPath:find}}.", { mustRead: [{ path: "{{resultPath:find}}", lines: [[1, 50]] }] })]);
    equal(ruleErrors(errs).length, 0, errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two tokens, one covered → exactly one error, for the uncovered one", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [
      find(), claudeTask({ id: "find-b", prompt: "find more" }),
      verify("Read {{resultPath:find}} and {{resultPath:find-b}}.", { after: ["find", "find-b"], mustRead: ["{{resultPath:find}}"] }),
    ]);
    const rules = ruleErrors(errs);
    equal(rules.length, 1, errs.join("\n"));
    ok(rules[0].includes("{{resultPath:find-b}}") && !rules[0].includes("{{resultPath:find}} but"), rules[0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("{{result:find}} alone needs no mustRead — there is no path to open", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [find(), verify("Summarise {{result:find}}.")]);
    equal(ruleErrors(errs).length, 0, errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a mustRead holding any {index} entry passes — the token may live inside the doc", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [find(), verify("Read {{resultPath:find}}.", { mustRead: [{ index: "index.json" }] })]);
    equal(ruleErrors(errs).length, 0, errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compute/integrate/manifest nodes are never asked — the guard, not the empty prompt, is what holds", () => {
  const task = { id: "n", prompt: "read {{resultPath:find}}", after: ["find"], provider: "claude", model: "claude-haiku-4-5-20251001" };
  const errors = [];
  const label = (t) => `task '${t.id}'`;
  for (const kind of ["compute", "integrate", "manifest"]) {
    errors.length = 0;
    validateResultPathReads([{ ...task, [kind]: kind === "integrate" ? { into: "x", from: ["find"] } : {} }], CFG, errors, label);
    equal(errors.length, 0, `${kind}: ${errors.join("\n")}`);
  }
  errors.length = 0;
  validateResultPathReads([task], CFG, errors, label); // the same task unguarded DOES trip it
  equal(errors.length, 1, errors.join("\n"));
});

test("an uncovered prompt on a non-transcript runner passes — the rule never demands what validateMustReadRunners would reject", () => {
  const dir = tmp();
  try {
    const cfg = { ...CFG, provider: { mode: "launch", launchCmd: "ollama launch claude --model {model} -- {args}", allowedRoots: [dir] } };
    const ollama = (over) => ({ provider: "ollama", model: "glm-4.6:cloud", ...over });
    const errs = loadErrs(dir, [ollama({ id: "find", prompt: "find the sites" }), ollama({ id: "verify", prompt: "Read {{resultPath:find}}.", after: ["find"] })], cfg);
    equal(ruleErrors(errs).length, 0, errs.join("\n"));
    // …and the same task WITH a mustRead still gets the runner message, unchanged.
    const errs2 = loadErrs(dir, [ollama({ id: "find", prompt: "find the sites" }), ollama({ id: "verify", prompt: "Read {{resultPath:find}}.", after: ["find"], mustRead: ["{{resultPath:find}}"] })], cfg, "plan2.json");
    ok(errs2.some((e) => /runner 'ollama' is not supported/.test(e)), errs2.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a code-review --mode swarm shape still validates — verifiers and the gate each name their paths", () => {
  const dir = tmp();
  try {
    const errs = loadErrs(dir, [
      claudeTask({ id: "shard-1", prompt: "Review the diff shard." }),
      claudeTask({ id: "shard-2", prompt: "Review the diff shard." }),
      claudeTask({ id: "check-1", prompt: "Read {{resultPath:shard-1}} and adjudicate every finding.", after: ["shard-1"], mustRead: ["{{resultPath:shard-1}}"] }),
      claudeTask({ id: "check-2", prompt: "Read {{resultPath:shard-2}} and adjudicate every finding.", after: ["shard-2"], mustRead: [{ path: "{{resultPath:shard-2}}", lines: [[1, 500]] }] }),
      claudeTask({ id: "gate", prompt: "Read {{resultPath:check-1}} and {{resultPath:check-2}}.", after: ["check-1", "check-2"], mustRead: ["{{resultPath:check-1}}", "{{resultPath:check-2}}"] }),
    ]);
    equal(errs.length, 0, errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Docs are the teaching surface, so a documented manifest must survive `validate`
// as written — an example the rule rejects teaches the wrong shape.
const SKILL = fileURLToPath(new URL("../skills/executing-swarms/SKILL.md", import.meta.url));

function docExample(heading) {
  const md = readFileSync(SKILL, "utf8");
  const after = md.slice(md.indexOf(heading));
  const block = after.match(/```json\n([\s\S]*?)\n```/);
  ok(block, `no json block under ${heading}`);
  return block[1];
}

test("the judge-panel example in executing-swarms validates as written", () => {
  const dir = tmp();
  try {
    // The example seats ollama judges beside a Claude one, so both providers must be
    // configured for the load to reach the rule at all.
    const cfg = { ...CFG, providers: { ...CFG.providers, ollama: { enabled: true, allowedRoots: [tmpdir()] } } };
    const errs = loadErrs(dir, JSON.parse(docExample("### Judge panel")).tasks, cfg);
    equal(errs.length, 0, errs.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
