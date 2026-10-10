// The leaf contract: parse a leaf's output, validate it, verify its citations and
// coverage, and re-ask a leaf that missed. runTask is injected so this holds no cycle.
import { readFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { transcriptPath, appendRunLog } from "../results.mjs";
import { validateValue } from "../schema.mjs";
import { dropNullOptionals } from "../native-schema.mjs";
import { extractCitations, verifyCitations, citationErrorLines, annotateCitations } from "../citations.mjs";
import { parseReadCalls, computeCoverage, coverageRetryBlock, uncoveredLines } from "../coverage.mjs";
import { addTokens, emptyTokens } from "../stream.mjs";
import { substituteTemplates } from "./run-task.mjs";

export function tryParseJson(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* not JSON */ }
  }
  return undefined;
}

// A schema miss is the leaf's own output being wrong and the validator's errors are
// field-precise, so it earns up to three corrective re-asks, from its own budget.
// A coverage shortfall gets its own four, so neither class starves the other; a
// refuted citation gets one (the checker may be wrong). Afterwards a schema miss is
// fatal; refutations and shortfalls only annotate. Runs before worktree collection.
const CONTRACT_SCHEMA_REASKS = 3;
// Coverage is chased only while the leaf is closing lines: `read` counts whole
// items, so a leaf paging a large file looks identical to one that never opened it.
// The first is always granted — one turn to show good faith — and the rest must be
// earned by the uncovered-line count actually falling. A leaf that plateaus stops.
const CONTRACT_COVERAGE_REASKS = 4;

// The coverage stamp a result carries. `missedItems` is the count a summary reads
// (a three-range item is one item, not three); `uncoverable` names the requirements
// nothing could have satisfied, so an operator can tell them from a leaf's failure.
const coverageStamp = (cov) => ({
  status: cov.status, required: cov.required, read: cov.read, missed: cov.missed,
  missedItems: cov.missedItems, uncoverable: cov.uncoverable,
});

export async function enforceLeafContract(task, r, taskCwd, resultsDir, cfg, io, hooks, runtime, runTask) {
  const runner = r.runner; // the runner that wrote this transcript — never runnerOf's claude default
  // Coverage is proven from the leaf's OWN transcript: parse its Read calls and
  // check them against `mustRead`. The transcript on disk already holds the full
  // attempt history of the session (resume appends, D10), so a re-ask's reads are
  // seen on re-assessment. A missing/unreadable transcript → parseReadCalls sees
  // no assistant events → null → a total miss (fail closed).
  const coverageOf = () => {
    if (!task.mustRead) return null;
    let text = "";
    try { text = readFileSync(transcriptPath(resultsDir, task.id), "utf8"); } catch { /* unparseable */ }
    const reads = parseReadCalls(text, runner, { cwd: taskCwd });
    return computeCoverage(task.mustRead, reads, {
      cwd: taskCwd,
      // The runner decides what a leaf could have been SHOWN: a codex line over the
      // model-visible cap is uncoverable, and must not sit in `required` forever.
      runner,
      substitute: (s) => substituteTemplates(s, resultsDir, cfg.resultInlineCap ?? 4000).prompt,
    });
  };
  // Schema first; when the shape holds, mechanically verify any citation-shaped
  // instances (N3). A task with `mustRead` but no `returns` skips schema entirely
  // (`parsed` undefined is fine — `finish` then leaves the output untouched).
  const assess = (output) => {
    let parsed, schemaErrs, cite;
    if (task.returns) {
      parsed = tryParseJson(output);
      if (parsed === undefined) {
        schemaErrs = ["output is not JSON — reply with a single JSON value matching the schema"];
      } else {
        // A bound schema forces every property present, so an optional one the model
        // declined arrives as null — no information, and the author's schema is what counts.
        parsed = dropNullOptionals(parsed, task.returns);
        const errs = validateValue(parsed, task.returns);
        if (errs.length) schemaErrs = errs;
        else if (task.verifyCitations !== false) {
          const cits = extractCitations(parsed, task.returns);
          if (cits.length) cite = verifyCitations(cits, { cwds: [taskCwd, task.originalCwd] });
        }
      }
    }
    return { parsed, schemaErrs, cite, cov: coverageOf() };
  };
  const failText = (errs) => `returns validation failed:\n  - ${errs.join("\n  - ")}`;
  const logCitations = (cite) => appendRunLog(resultsDir, {
    ts: new Date().toISOString(), event: "citations", id: task.id,
    ...runtime?.identity?.(task),
    checked: cite.checked, drifted: cite.drifted.length, refuted: cite.refuted.length,
  });
  const logCoverage = (cov, retried) => appendRunLog(resultsDir, {
    ts: new Date().toISOString(), event: "coverage", id: task.id,
    status: cov.status, required: cov.required, read: cov.read, missed: cov.missed, retried,
  });
  // The coverage stamp a result carries, logged once per assessment.
  const stampCoverage = (out, a, retried) => {
    if (!a.cov) return out;
    logCoverage(a.cov, retried);
    return { ...out, coverage: coverageStamp(a.cov) };
  };
  // A schema-clean result: annotate every citation in place, re-serialize the
  // annotated output, and attach loud stats. Then stamp coverage. Refutations and
  // coverage shortfalls never fail the leaf — both are recorded, and the caller
  // surfaces an incomplete `coverage` in the closing block.
  const finish = (res, a, retried = false) => {
    // rawOutput is failure-only — an ok result has no correction still to make, and
    // a stale copy of its own output beside `output` reads as a second answer.
    const { rawOutput: _raw, ...rest } = res;
    let out = rest;
    if (a.cite) {
      const cite = a.cite;
      annotateCitations(cite);
      logCitations(cite);
      out = {
        ...out,
        citations: { checked: cite.checked, drifted: cite.drifted.length, refuted: cite.refuted.length },
      };
      if (cite.refuted.length) out.citationRefuted = cite.refuted.map((c) => ({ path: c.path, reason: c.reason }));
    }
    // The stripped, annotated value is what validated, so it is what gets stored.
    if (task.returns && a.parsed !== undefined) out = { ...out, output: JSON.stringify(a.parsed) };
    return stampCoverage(out, a, retried);
  };
  const failSchema = (res, errs, suffix = "") => ({
    ...res, ok: false, output: failText(errs) + suffix, schemaErrors: errs,
    // The leaf's own output, kept beside the validator's text: a re-run re-asks
    // from this instead of re-sending the prompt and redoing the work.
    rawOutput: res.output,
  });
  // The leaf engaged with NOTHING it was told to read. That is not a finding to
  // annotate, it is a leaf that never did the task — and `missed` alone cannot say
  // so, since a leaf that paged 2,000 of 8,000 lines looks much the same. `unparseable`
  // is exempt: that is the engine failing to read the transcript, not the model idling.
  const failCoverage = (res, a, retried) => ({
    ...finish(res, a, retried),
    ok: false,
    coverageFailed: true,
    // The teaching block, so a corrective resume has something to re-send; and the
    // leaf's own answer, kept for that resume the same way failSchema keeps it.
    output: coverageRetryBlock(a.cov.gaps, { indexErrors: a.cov.errors, runner }),
    rawOutput: res.output,
  });
  // What an idling leaf looks like, whatever else the checker found. Judged over
  // `gaps` alone: those are the requirements the leaf COULD have read. A mustRead
  // path that never resolved is the engine's gap, so a leaf that read none of it
  // is short, not idle.
  const idle = (cov) => Boolean(cov) && cov.status === "incomplete" && cov.gaps.length > 0 && cov.creditedLines === 0;
  // A schema miss that is ALSO an idling leaf fails on both counts: the schema text
  // stays (that is why the leaf failed), and the coverage stamp rides along so the
  // run-level gap entry — and the closing block's red line — still get produced.
  const failSchemaIdle = (res, errs, suffix, a, retried) => {
    const out = failSchema(res, errs, suffix);
    return idle(a.cov) ? { ...stampCoverage(out, a, retried), coverageFailed: true } : out;
  };

  let cur = r;
  let a = assess(cur.output);
  let schemaAttempt = 0;   // schema re-asks spent
  let covAttempt = 0;      // coverage re-asks spent
  let turns = 0;           // re-asks of any kind, for the retry log
  let uncoveredAtAsk = null; // the gap when the last coverage re-ask was granted
  for (;;) {
    const schemaErrs = a.schemaErrs?.length ? a.schemaErrs : null;
    const refuted = a.cite?.refuted.length || 0;
    const covMiss = a.cov && a.cov.status !== "complete";
    const uncovered = covMiss ? uncoveredLines(a.cov.gaps) : 0;
    const idling = idle(a.cov);

    // Clean, or nothing left a re-ask may chase: record and finish — unless the leaf
    // idled, which is a failure however clean the rest of its output looks.
    if (!schemaErrs && !refuted && !covMiss) return finish(cur, a, turns > 0);
    if (!cur.sessionId) {
      if (idling) return failCoverage(cur, a, turns > 0);
      if (schemaErrs) return failSchema(cur, schemaErrs, "\n(no session id — re-ask unavailable)");
      return finish(cur, a, turns > 0);
    }
    if (schemaErrs && schemaAttempt >= CONTRACT_SCHEMA_REASKS) return failSchemaIdle(cur, schemaErrs, "", a, turns > 0);
    // Progress is measured in uncovered LINES, not whole items read: a leaf paging
    // 2,000 of 8,000 lines has read 0 items, and would read as stonewalling.
    const covAllowed = covMiss && covAttempt < CONTRACT_COVERAGE_REASKS
      && (covAttempt === 0 || uncovered < uncoveredAtAsk);
    if (!schemaErrs && !covAllowed && !(refuted && turns === 0)) {
      return idling ? failCoverage(cur, a, turns > 0) : finish(cur, a, turns > 0);
    }
    if (schemaErrs) schemaAttempt += 1;
    if (covAllowed) { covAttempt += 1; uncoveredAtAsk = uncovered; }
    turns += 1;
    // Each re-ask carries the class that earned it: schema (with the schema itself —
    // "expected object" alone doesn't name fields), a coverage block naming each unread
    // range as a literal Read call, or a first-turn citation list. A coverage block
    // rides EVERY coverage re-ask, not just the first: the leaf is told once more each
    // time, and only the class that stopped earning turns goes quiet.
    const blocks = [];
    if (schemaErrs) blocks.push(
      `Your output did not match the task's returns schema:\n  - ${schemaErrs.join("\n  - ")}\n` +
      `The required schema is:\n${JSON.stringify(task.returns, null, 2)}`,
    );
    if (refuted && turns === 1) blocks.push(
      `Some citations in your output could not be verified against the actual files:\n  - ${citationErrorLines(a.cite.refuted).join("\n  - ")}`,
    );
    if (covAllowed) blocks.push(coverageRetryBlock(a.cov.gaps, { indexErrors: a.cov.errors, runner }));
    // A mustRead-only task may be a prose leaf: demanding JSON there would replace its answer.
    const closing = task.returns
      ? "Reply with ONLY the corrected JSON — no prose, no fences."
      : "Reply with your complete corrected answer, in the same form the task originally asked for.";
    const retryPrompt = `${blocks.join("\n\n")}\n${closing}`;
    appendRunLog(resultsDir, {
      ts: new Date().toISOString(), event: "leaf-contract-retry", id: task.id,
      ...runtime?.identity?.(task), attempt: turns,
      reason: schemaErrs ? "schema" : covAllowed ? "coverage" : "citations",
      ...(covAllowed && { uncovered }),
    });
    const leafLog = createWriteStream(join(resultsDir, "results", `${task.id}.log`), { flags: "a" });
    const next = await runTask({ ...task, cwd: taskCwd, resume: cur.sessionId }, retryPrompt, cfg, io, leafLog, hooks, runtime);

    const combined = {
      ...cur,
      durationMs: cur.durationMs + next.durationMs,
      tokens: addTokens(cur.tokens || emptyTokens(), next.tokens || emptyTokens()),
      ...((cur.costUsd != null || next.costUsd != null) && { costUsd: (cur.costUsd || 0) + (next.costUsd || 0) }),
      ...((cur.numTurns != null || next.numTurns != null) && { numTurns: (cur.numTurns || 0) + (next.numTurns || 0) }),
      sessionId: next.sessionId ?? cur.sessionId,
      schemaRetried: true,
    };
    // Re-ask process itself failed: the loop ends here. A schema miss is still fatal;
    // a citation/coverage correction that never ran falls back to the ORIGINAL output
    // and its first-pass annotations — a failed correction must not destroy findings
    // the first pass made.
    if (!next.ok) {
      if (schemaErrs) return failSchemaIdle(combined, [`re-ask failed (exit ${next.exit}): ${next.output.slice(0, 200)}`], "", a, true);
      // The correction never ran, so the FIRST pass is the verdict — and if that pass
      // read nothing, a re-ask that failed cannot launder it into a completed leaf.
      return idling ? failCoverage(combined, a, true) : finish(combined, a, true);
    }
    cur = { ...combined, ok: true, output: next.output };
    a = assess(next.output);
  }
}
