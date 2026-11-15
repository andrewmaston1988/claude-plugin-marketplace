// `swarm validate` refusing a dominated seat, and `run` inheriting the refusal
// through the validated-bytes marker. A seat over the refusal canon that a
// launchable model beats on both quality and cost fails unless the task says why
// it is seated.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { gateHome, tmp } from "./helpers/cli-fixture.mjs";
import { snap, seg } from "./helpers/cost-snapshots.mjs";
import { writeRosterEntry } from "../src/roster.mjs";
import { REFUSAL_N } from "../src/seats.mjs";

const SEAT = "dom:cloud"; // a poor record on the meter's dearest band
const CHAMP = "champ:cloud"; // strictly better and cheaper, and launchable
const REFUSAL = "has not been validated as written";
const EXAMPLE = '"seatReason": "cross-family verifier';

const gradedRow = (model, score, i) => JSON.stringify({
  resultsDir: `C:/runs/${model}-${i}`, leaf: `l${i}`, model, domain: "node", outcome: "completed",
  grades: { adherence: score, handoff: score, truthfulness: score, depth: score },
  note: "", assessedBy: { session: "s1", date: "2026-11-15" },
});
const store = (model, score, n) => Array.from({ length: n }, (_, i) => gradedRow(model, score, i));

// A repo + a gated home + a manifest. The store and the meter history are what
// make SEAT dominated; `seed` false gives the empty store `swarm validate` must
// stay silent about.
function world({ tasks, grading = true, seed = true, digest, resultsDir = "out" } = {}) {
  const dir = tmp();
  const home = gateHome(join(dir, "home"), {
    grading: { enabled: grading },
    provider: { allowedRoots: [tmpdir()] },
  });
  if (seed) {
    writeFileSync(join(home, "model-scores.jsonl"),
      [...store(SEAT, 6, 40), ...store(CHAMP, 9, 40)].join("\n") + "\n");
  }
  writeRosterEntry("ollama", {
    hydratedAt: Date.now(),
    source: null,
    models: [{ provider: "ollama", model: CHAMP }, { provider: "ollama", model: SEAT }],
  }, { SWARM_HOME: home });
  writeFileSync(join(home, "usage-history.jsonl"),
    JSON.stringify(snap(1, [seg("dom", 2000, 60), seg("champ", 2000, 10)], 50)) + "\n");
  const path = join(dir, "m.json");
  writeFileSync(path, JSON.stringify({
    ...(resultsDir ? { resultsDir } : {}),
    tasks: tasks ?? [task()],
    ...(digest && { digest }),
  }));
  return { dir, home, path };
}

const task = (over = {}) => ({ id: "lane", prompt: "x", provider: "ollama", model: SEAT, ...over });
const envOf = (w) => ({ SWARM_HOME: w.home, SWARM_SHIM_LOG: join(w.dir, "shim.log"), SWARM_SHIM_OUTPUT: "done" });
const validate = (w) => runCli(["validate", w.path], { cwd: w.dir, env: envOf(w) });
const run = (w) => runCli(["run", w.path], { cwd: w.dir, env: envOf(w) });
const markers = (w) => {
  const dir = join(w.home, "validated");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const allowanceWarnings = (out) => out.split("\n").filter((l) => l.startsWith("warning:") && l.includes("weekly-allowance"));
const cleanup = (w) => rmSync(w.dir, { recursive: true, force: true });

test("validate: a dominated seat over the refusal canon fails, names the record and the escape, and writes no marker", () => {
  const w = world();
  try {
    const r = validate(w);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(!r.stdout.includes("manifest OK"), `the approval line may not print above a refusal:\n${r.stdout}`);
    ok(r.stdout.includes("seats:"), `the block still prints the evidence:\n${r.stdout}`);
    ok(r.stdout.includes(`dominated by ${CHAMP}`), r.stdout);
    const e = r.stderr;
    ok(e.includes("task 'lane'"), e);
    ok(e.includes(`seats ollama/${SEAT}`), e);
    ok(/overall \d\.\d\d n=40/.test(e), e);
    ok(e.includes(`dominated by ${CHAMP}`), e);
    ok(e.includes("or a frontier model"), e);
    ok(e.includes(EXAMPLE), e);
    deepEqual(markers(w), [], "a refused manifest is not validated");
  } finally { cleanup(w); }
});

test("validate: the same seat with a seatReason validates, and the block prints the reason beside it", () => {
  const w = world({ tasks: [task({ seatReason: "cross-family verifier: every non-deepseek ollama model is dominated" })] });
  try {
    const r = validate(w);
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("manifest OK"), r.stdout);
    ok(r.stdout.includes("reason: cross-family verifier"), r.stdout);
    equal(markers(w).length, 1);
  } finally { cleanup(w); }
});

test("validate: a seat is judged per task — the reason covers its own task, and its fallback seat", () => {
  const both = world({ tasks: [task({ id: "with-reason", seatReason: "cross-family verifier" }), task({ id: "no-reason" })] });
  try {
    const r = validate(both);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("task 'no-reason'"), r.stderr);
    ok(!r.stderr.includes("task 'with-reason'"), `the reasoned task is not refused:\n${r.stderr}`);
    equal((r.stderr.match(/^ {2}- task /gm) || []).length, 1, r.stderr);
  } finally { cleanup(both); }

  // A fallbackModel is a real seat when quota forces it.
  const fallback = world({ tasks: [task({ id: "lane", model: CHAMP, fallbackModel: SEAT, fallbackProvider: "ollama" })] });
  try {
    const r = validate(fallback);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("task 'lane fallback'"), r.stderr);
  } finally { cleanup(fallback); }

  // The digest is a seat too.
  const digest = world({ tasks: [task({ model: CHAMP })], digest: { provider: "ollama", model: SEAT } });
  try {
    const r = validate(digest);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes("task 'digest'"), r.stderr);
    ok(r.stderr.includes('"seatReason"'), r.stderr);
    ok(r.stderr.includes("to the digest block"), r.stderr);
    ok(!r.stderr.includes("digest.seatReason"), r.stderr);
    ok(!r.stderr.includes("__digest"), r.stderr);
  } finally { cleanup(digest); }

  const reasoned = world({ tasks: [task({ model: CHAMP })], digest: { provider: "ollama", model: SEAT, seatReason: "digest voice" } });
  try {
    const r = validate(reasoned);
    equal(r.status, 0, r.stderr);
    ok(r.stdout.includes("reason: digest voice"), r.stdout);
  } finally { cleanup(reasoned); }
});

test("validate: grading off, or an empty store, refuses nothing and prints no block", () => {
  for (const opts of [{ grading: false }, { seed: false }]) {
    const w = world(opts);
    try {
      const r = validate(w);
      equal(r.status, 0, `${JSON.stringify(opts)}: ${r.stderr}`);
      ok(r.stdout.includes("manifest OK"), r.stdout);
      ok(!r.stdout.includes("seats:"), r.stdout);
    } finally { cleanup(w); }
  }
});

test("run: after a refused validate the same bytes are refused as unvalidated, and nothing launches", () => {
  const w = world();
  try {
    equal(validate(w).status, 1);
    const r = run(w);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(REFUSAL), r.stderr);
    ok(!existsSync(envOf(w).SWARM_SHIM_LOG), "nothing may spawn");
    ok(!existsSync(join(w.dir, "out")), "no run dir may be created");
  } finally { cleanup(w); }
});

test("validate: a refused re-validate revokes the earlier marker, so run refuses the same bytes", () => {
  const w = world();
  const scores = (n) => [...store(SEAT, 6, n), ...store(CHAMP, 9, REFUSAL_N)].join("\n") + "\n";
  try {
    // n=39 sits in the fair-shot band, so this pass is approved and marks the bytes.
    writeFileSync(join(w.home, "model-scores.jsonl"), scores(REFUSAL_N - 1));
    equal(validate(w).status, 0);
    equal(markers(w).length, 1);
    // More grades land: the same seat is now over the refusal canon and dominated.
    writeFileSync(join(w.home, "model-scores.jsonl"), scores(REFUSAL_N));
    const refused = validate(w);
    equal(refused.status, 1, refused.stdout + refused.stderr);
    deepEqual(markers(w), [], "a refused re-validate revokes the earlier marker");
    const r = run(w);
    equal(r.status, 1, r.stdout + r.stderr);
    ok(r.stderr.includes(REFUSAL), r.stderr);
  } finally { cleanup(w); }
});

test("seatReason: a number, a blank string or a null digest reason is a validation error naming the field", () => {
  const cases = [
    { label: "number", body: { tasks: [task({ seatReason: 5 })] } },
    { label: "blank", body: { tasks: [task({ seatReason: "   " })] } },
    { label: "digest null", body: { tasks: [task({ model: CHAMP })], digest: { provider: "ollama", model: CHAMP, seatReason: null } } },
  ];
  for (const { label, body } of cases) {
    const w = world({ tasks: body.tasks, digest: body.digest });
    try {
      const r = validate(w);
      equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
      ok(r.stderr.includes("seatReason must say why this seat is used"), `${label}: ${r.stderr}`);
      ok(r.stderr.includes(EXAMPLE), `${label}: ${r.stderr}`);
      deepEqual(markers(w), [], label);
    } finally { cleanup(w); }
  }
});

test("seatReason: a child-plan task, a forEach template and the digest all carry it to the seats check", () => {
  const w = world({
    tasks: [
      { id: "src", prompt: "list", provider: "ollama", model: CHAMP },
      {
        id: "audit",
        manifest: "child.json",
        after: ["src"],
        forEach: { from: "src", maxItems: 2 },
        seatReason: "child plans are seated from the parent",
      },
      { id: "fan", prompt: "impl {{item}}", provider: "ollama", model: SEAT, after: ["src"], forEach: { from: "src", maxItems: 2 }, seatReason: "fan-out lane" },
    ],
    digest: { provider: "ollama", model: SEAT, seatReason: "digest voice" },
  });
  try {
    writeFileSync(join(w.dir, "child.json"), JSON.stringify({
      tasks: [{ id: "one", prompt: "audit {{item}}", provider: "ollama", model: SEAT, seatReason: "child leaf" }],
    }));
    const r = validate(w);
    // Exit 0 is the proof for all three: a refusal is per task, so any one of
    // them dropping its seatReason would refuse the manifest.
    equal(r.status, 0, `${r.stdout}${r.stderr}`);
    ok(!r.stderr.includes("unknown key"), `seatReason is a known task key: ${r.stderr}`);
    ok(r.stdout.includes("reason: "), r.stdout);
  } finally { cleanup(w); }
});

