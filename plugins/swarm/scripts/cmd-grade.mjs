// `swarm grade --init | --file | --waive` — split out of swarm.mjs, which now just dispatches
// to it, the same shape as cmd-cost.mjs. The grading modules stay lazily imported inside each
// command, so no other subcommand pays for loading them.
import { join, resolve, dirname, isAbsolute } from "node:path";
import { getConfig } from "../src/config.mjs";
import { modelRoster } from "../src/roster.mjs";
import { defaultProviderRegistry } from "../src/default-providers.mjs";
import { identityKey } from "../src/contracts.mjs";
import { dim, out, err } from "../src/ui.mjs";

// `grade --init` — one skeleton row per model leaf. It is deliberately
// unappendable as written: validation rejects a null universal, so an untouched
// skeleton cannot land.
export async function cmdGradeInit(dir) {
  const { gradeInit } = await import("../src/grade-init.mjs");
  const { error, lines } = gradeInit(dir);
  if (error) {
    err(error);
    return 1;
  }
  for (const line of lines) out(line);
  return 0;
}

// `grade --file` — the batch carries only judgement. model, mechanical and
// declared are resolved from disk here, so they cannot be fabricated.
export async function cmdGradeFile(path) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { readResult, mechanicalOf } = await import("../src/results.mjs");
  const { appendRows, scoresPath } = await import("../src/scores.mjs");
  if (!existsSync(path)) { err(`swarm: no grades file at ${path}`); return 1; }
  let batch;
  try {
    batch = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    err(`swarm: ${path} is not valid JSON: ${e.message}`);
    return 1;
  }
  let dir = batch?.resultsDir;
  const session = batch?.session;
  if (typeof dir !== "string" || !dir.trim() || !Array.isArray(batch.rows) || !batch.rows.length) {
    err('swarm: grades file must be { "resultsDir": "<run dir>", "session": "<id>", "rows": [ … ] }');
    return 1;
  }
  // grades.json lives inside its own resultsDir — a relative resultsDir was
  // relative to wherever `grade --init` ran, not to this file's location, so
  // the directory holding grades.json already IS the results dir.
  if (!isAbsolute(dir)) dir = dirname(path);
  if (typeof session !== "string" || !session.trim() || session.startsWith("<")) {
    err('swarm: fill in "session" with this session\'s id — every row records who graded it.');
    return 1;
  }

  // What each model was declared to be, keyed the way a result names it — the
  // same identity reading the roster merges on, so a provider cannot split a row.
  const cacheEntries = new Map();
  for (const m of modelRoster({ config: getConfig(), registry: defaultProviderRegistry() }).models) {
    const declared = {
      capabilities: m.capabilities ?? null,
      contextLength: m.contextLength ?? null,
      parameterCount: m.parameterCount ?? null,
    };
    cacheEntries.set(identityKey(m), declared);
    if (!m.provider) cacheEntries.set(m.model, declared);
  }
  const date = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();
  const manifestTasks = await readManifestTasks(dir);
  const rows = [];
  // Collect every missing leaf before failing, matching validateRow's batch-wide
  // error collection — one round-trip should surface all of them, not the first.
  const missing = batch.rows.filter((r) => !readResult(dir, r?.leaf)).map((r) => r?.leaf);
  if (missing.length) {
    err(`swarm: no results/<id>.json in ${dir} for: ${missing.join(", ")} — the mechanical block cannot be fabricated, so nothing was written.`);
    return 1;
  }
  for (const r of batch.rows) {
    const result = readResult(dir, r.leaf);
    const declared = cacheEntries.get(identityKey(result)) || cacheEntries.get(result.model);
    const { isClaudeModel } = await import("../src/models.mjs");
    if (!declared && !isClaudeModel(result.model)) err(dim(`warning: ${result.provider ? `${result.provider}/` : ""}${result.model} is not in the model roster — declared capabilities recorded as null (run \`swarm models\` to refresh)`));
    rows.push({
      ts,
      resultsDir: dir,
      leaf: r.leaf,
      ...(result.provider ? { provider: result.provider } : {}),
      model: result.model,
      effort: manifestTasks.get(r.leaf)?.effort ?? null,
      domain: r.domain,
      ...(r.grades !== undefined && { grades: r.grades }),
      outcome: r.outcome,
      note: r.note ?? "",
      assessedBy: { session, date },
      mechanical: mechanicalOf(result),
      declared: declared ?? null,
    });
  }
  try {
    appendRows(rows, scoresPath());
  } catch (e) {
    err(`swarm: ${e.message}`);
    return 1;
  }
  out(`${rows.length} row(s) appended to ${scoresPath()}`);
  return 0;
}

// `grade --waive` — the one escape from the grading nudges (D5): a dir that
// exists, a reason that says why, tmp+rename so a torn write never leaves a
// half-written waiver behind. Re-waiving overwrites.
export async function cmdGradeWaive(dir, reason) {
  const { existsSync, writeFileSync, renameSync } = await import("node:fs");
  const { waiverPath } = await import("../src/results.mjs");
  if (dir) dir = resolve(dir);
  if (!dir || !existsSync(dir)) {
    err(`swarm: no results dir at ${dir ?? "(none given)"} — grade --waive needs an existing resultsDir`);
    return 1;
  }
  if (!reason || !reason.trim()) {
    err("swarm: grade --waive needs a non-empty --reason — the waiver is the one escape and must say why");
    return 1;
  }
  const p = waiverPath(dir);
  writeFileSync(`${p}.tmp`, JSON.stringify({ waivedAt: new Date().toISOString(), reason }, null, 2) + "\n");
  renameSync(`${p}.tmp`, p);
  out(p);
  return 0;
}

// Effort is a manifest field, not a result field; the snapshot at dispatch is
// where a run records its own intent.
async function readManifestTasks(dir) {
  const map = new Map();
  try {
    const { readFileSync } = await import("node:fs");
    const doc = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    for (const t of doc?.tasks || []) map.set(t.id, t);
  } catch { /* a run without a snapshot simply records no effort */ }
  return map;
}
