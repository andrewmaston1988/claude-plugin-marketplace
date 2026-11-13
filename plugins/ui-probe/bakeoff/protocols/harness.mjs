// The one harness for this lane (RQ7 protocols + RQ6 TV): task driving, timing, repeats,
// measurement and the output schema. Every contender is a thin adapter behind `probe()`,
// so the tool is the only variable between rows.
//
// Fairness rules this file owns:
//   - one `drive()` loop runs every adapter, with the same repeat count and the same clock;
//   - one `measure()` turns every observation into the same byte/token columns;
//   - one `row()` shape is emitted for every contender, so no row can report a number the
//     others are not also asked for.
// A contender that cannot run a task emits an OPEN row carrying the exact probe that would
// run later. It does not emit a zero.

import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA = "ui-probe-bakeoff/row@1";
export const DEFAULT_REPEATS = 5;
/** Fixed by the plan's RQ10 meter: one tokenizer estimate, chars/4, so size is model-free. */
export const CHARS_PER_TOKEN = 4;

export const bytesOf = (text) => Buffer.byteLength(String(text ?? ""), "utf8");
export const tokensOf = (text) => Math.ceil(bytesOf(text) / CHARS_PER_TOKEN);

/** The serialised observation, counted the one way every row is counted. */
export function measure(transcript) {
  const text = String(transcript ?? "");
  return {
    bytes: bytesOf(text),
    tokens: tokensOf(text),
    lines: text === "" ? 0 : text.split(/\r?\n/).length,
  };
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarise(values) {
  if (values.length === 0) return { n: 0, median: null, min: null, max: null };
  return {
    n: values.length,
    median: round(median(values)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

const round = (value) => (value == null ? null : Math.round(value * 100) / 100);

/**
 * One contender on one task, repeated. Identical for every adapter: same loop, same clock,
 * same measurement. `probe` may return `{ open }` (the environment cannot run it) or throw
 * (the probe failed); both become rows, never crashes.
 */
export async function measureOne({ adapter, task, repeats, clock }) {
  const samples = [];
  let observation = null;
  let failure = null;

  for (let attempt = 0; attempt < repeats; attempt += 1) {
    const started = clock();
    try {
      const result = await adapter.probe(task, { attempt });
      const elapsed = clock() - started;
      observation = result;
      if (result?.open) break; // an OPEN row is a fact about the environment, not a timing
      samples.push(elapsed);
    } catch (err) {
      failure = err;
      break;
    }
  }

  if (observation?.open) {
    return {
      schema: SCHEMA,
      contender: adapter.id,
      contenderLabel: adapter.label,
      task: task.id,
      taskTitle: task.title,
      status: "OPEN",
      verified: null,
      ms: summarise([]),
      bytes: 0,
      tokens: 0,
      lines: 0,
      transcript: "",
      open: observation.open,
      guard: adapter.guard?.mechanism ?? null,
      command: task.command ?? null,
      note: null,
    };
  }

  if (observation === null) {
    return {
      schema: SCHEMA,
      contender: adapter.id,
      contenderLabel: adapter.label,
      task: task.id,
      taskTitle: task.title,
      status: "FAIL",
      verified: false,
      ms: summarise(samples),
      bytes: 0,
      tokens: 0,
      lines: 0,
      transcript: "",
      open: null,
      guard: adapter.guard?.mechanism ?? null,
      command: task.command ?? null,
      note: failure?.message ?? "no observation",
    };
  }

  const transcript = String(observation.transcript ?? "");
  const size = measure(transcript);
  return {
    schema: SCHEMA,
    contender: adapter.id,
    contenderLabel: adapter.label,
    task: task.id,
    taskTitle: task.title,
    status: task.verify?.(observation) ? "PASS" : "FAIL",
    verified: task.verify ? Boolean(task.verify(observation)) : null,
    ms: summarise(samples),
    bytes: size.bytes,
    tokens: size.tokens,
    lines: size.lines,
    transcript,
    open: null,
    guard: adapter.guard?.mechanism ?? null,
    command: task.command ?? null,
    note: observation.note ?? null,
  };
}

/** Every adapter against every task it declares, in one loop. */
export async function drive({ adapters, tasks, repeats = DEFAULT_REPEATS, clock = () => performance.now() }) {
  const rows = [];
  for (const adapter of adapters) {
    for (const task of tasks) {
      if (!adapter.tasks.includes(task.id)) continue;
      rows.push(await measureOne({ adapter, task, repeats, clock }));
    }
  }
  return rows;
}

/**
 * The read-only proof, run identically for each contender: attempt one call that is off
 * its allowlist and record that it was refused before reaching the wire.
 */
export async function driveGuards({ adapters }) {
  const out = [];
  for (const adapter of adapters) {
    const guard = adapter.guard ?? {};
    let bite = null;
    try {
      bite = await guard.bite();
    } catch (err) {
      bite = { attempt: guard.describe?.() ?? adapter.id, blocked: false, message: err.message };
    }
    out.push({
      contender: adapter.id,
      mechanism: guard.mechanism ?? null,
      allowlist: guard.describe?.() ?? null,
      attempt: bite?.attempt ?? null,
      blocked: Boolean(bite?.blocked),
      message: bite?.message ?? null,
    });
  }
  return out;
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function msCell(ms) {
  if (!ms || ms.n === 0) return "—";
  return `${ms.median} (${ms.min}–${ms.max})`;
}

export function toMarkdown(rows) {
  const head =
    "| Task | Contender | Verified | Median ms (min–max) | Transcript bytes | Est. tokens | Read-only layer |\n" +
    "|---|---|---|---|---|---|---|";
  const body = rows.map((row) =>
    [
      cell(row.taskTitle),
      cell(row.contenderLabel),
      row.status === "OPEN" ? "**OPEN**" : row.verified ? "PASS" : "FAIL",
      msCell(row.ms),
      row.bytes,
      row.tokens,
      cell(row.guard ?? ""),
    ].join(" | "),
  );
  return [head, ...body.map((line) => `| ${line} |`)].join("\n");
}

export function toGuardMarkdown(guards) {
  const head = "| Contender | Allowlist | Off-list attempt | Refused | Evidence |\n|---|---|---|---|---|";
  const body = guards.map((g) =>
    [cell(g.contender), cell(g.allowlist), cell(g.attempt), g.blocked ? "yes" : "**no**", cell(g.message)].join(" | "),
  );
  return [head, ...body.map((line) => `| ${line} |`)].join("\n");
}

export function writeArtifact(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
