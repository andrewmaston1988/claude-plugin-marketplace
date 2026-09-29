// The leaf contract: parse a leaf's output, validate it, verify its citations and
// coverage, and re-ask a leaf that missed. runTask is injected so this holds no cycle.
import { readFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { transcriptPath, appendRunLog } from "../results.mjs";
import { validateValue } from "../schema.mjs";
import { dropNullOptionals } from "../native-schema.mjs";
import { extractCitations, verifyCitations, citationErrorLines, annotateCitations } from "../citations.mjs";
import { parseReadCalls, computeCoverage, coverageRetryBlock } from "../coverage.mjs";
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
// field-precise, so it earns up to three corrective re-asks; a refuted citation or
// coverage shortfall gets ONE (the checker may be wrong). Afterwards a schema miss
// is fatal; refutations and shortfalls only annotate. Runs before worktree collection.
const CONTRACT_SCHEMA_REASKS = 3;

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
        output: JSON.stringify(a.parsed),
        citations: { checked: cite.checked, drifted: cite.drifted.length, refuted: cite.refuted.length },
      };
      if (cite.refuted.length) out.citationRefuted = cite.refuted.map((c) => ({ path: c.path, reason: c.reason }));
    }
    if (a.cov) {
      logCoverage(a.cov, retried);
      out = { ...out, coverage: { status: a.cov.status, required: a.cov.required, read: a.cov.read, missed: a.cov.missed } };
    }
    return out;
  };
  const failSchema = (res, errs, suffix = "") => ({
    ...res, ok: false, output: failText(errs) + suffix, schemaErrors: errs,
    // The leaf's own output, kept beside the validator's text: a re-run re-asks
    // from this instead of re-sending the prompt and redoing the work.
    rawOutput: res.output,
  });

  let cur = r;
  let a = assess(cur.output);
  let attempt = 0;
  for (;;) {
    const schemaErrs = a.schemaErrs?.length ? a.schemaErrs : null;
    const refuted = a.cite?.refuted.length || 0;
    const covMiss = a.cov && a.cov.status !== "complete";

    // Clean, or nothing left a re-ask may chase: record and finish (never fail).
    if (!schemaErrs && !refuted && !covMiss) return finish(cur, a, attempt > 0);
    if (!cur.sessionId) {
      if (schemaErrs) return failSchema(cur, schemaErrs, "\n(no session id — re-ask unavailable)");
      return finish(cur, a, attempt > 0);
    }
    // Only a schema miss spends more than one turn: it is the leaf's own output that
    // is wrong, while a refutation or shortfall is a claim about the checker, and a
    // leaf arguing with a false refutation buys annotations at the price of turns.
    if (!schemaErrs && attempt > 0) return finish(cur, a, true);
    if (attempt >= CONTRACT_SCHEMA_REASKS) return failSchema(cur, schemaErrs);

    attempt += 1;
    // The first re-ask carries every class that fired, in order: schema (carries the
    // schema itself — "expected object" alone doesn't name fields), citations (name
    // file/line/fix), then coverage (name each unread range as a literal Read call).
    // Later ones carry the schema block alone — its siblings already had their turn.
    const blocks = [];
    if (schemaErrs) blocks.push(
      `Your output did not match the task's returns schema:\n  - ${schemaErrs.join("\n  - ")}\n` +
      `The required schema is:\n${JSON.stringify(task.returns, null, 2)}`,
    );
    if (attempt === 1) {
      if (refuted) blocks.push(
        `Some citations in your output could not be verified against the actual files:\n  - ${citationErrorLines(a.cite.refuted).join("\n  - ")}`,
      );
      if (covMiss) blocks.push(coverageRetryBlock(a.cov.gaps, { indexErrors: a.cov.errors, runner }));
    }
    // A mustRead-only task may be a prose leaf: demanding JSON there would replace its answer.
    const closing = task.returns
      ? "Reply with ONLY the corrected JSON — no prose, no fences."
      : "Reply with your complete corrected answer, in the same form the task originally asked for.";
    const retryPrompt = `${blocks.join("\n\n")}\n${closing}`;
    appendRunLog(resultsDir, {
      ts: new Date().toISOString(), event: "leaf-contract-retry", id: task.id,
      ...runtime?.identity?.(task), attempt,
    });
    const leafLog = createWriteStream(join(resultsDir, "results", `${task.id}.log`), { flags: "a" });
    const next = await runTask({ ...task, cwd: taskCwd, resume: cur.sessionId }, retryPrompt, cfg, io, leafLog, hooks, runtime);

    const combined = {
      ...cur,
      durationMs: cur.durationMs + next.durationMs,
      tokens: addTokens(cur.tokens || emptyTokens(), next.tokens || emptyTokens()),
      ...((cur.costUsd != null || next.costUsd != null) && { costUsd: (cur.costUsd || 0) + (next.costUsd || 0) }),
      sessionId: next.sessionId ?? cur.sessionId,
      schemaRetried: true,
    };
    // Re-ask process itself failed: the loop ends here. A schema miss is still fatal;
    // a citation/coverage correction that never ran falls back to the ORIGINAL output
    // and its first-pass annotations — a failed correction must not destroy findings
    // the first pass made.
    if (!next.ok) {
      return schemaErrs
        ? failSchema(combined, [`re-ask failed (exit ${next.exit}): ${next.output.slice(0, 200)}`])
        : finish(combined, a, true);
    }
    cur = { ...combined, ok: true, output: next.output };
    a = assess(next.output);
  }
}
