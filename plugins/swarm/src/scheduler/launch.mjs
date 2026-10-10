// One leaf, from seat to settle: ask mode, isolation, the resume/corrective
// decision, the dispatch, worktree collection, retry/fallback and the cost warn.
import { mkdirSync, createWriteStream, appendFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { storedTurnCount } from "../contracts.mjs";
import { withLeafNotices, READS_PART_CEILING } from "../leaf-notices.mjs";
import { resolveMustRead, codexCoverable, codexReadPlan, splitReadPlan } from "../coverage.mjs";
import { isClaudeModel } from "../models.mjs";
import { scratchPath as digestScratchPath } from "../digest.mjs";
import { readResult, writeResult, appendRunLog, writeDigestMd, formatTokens } from "../results.mjs";
import { taskKey, writeTaskResult } from "../task-key.mjs";
import { addTokens, emptyTokens, tokenTotal, workTokens } from "../stream.mjs";
import { parseQuotaReset } from "../quota.mjs";
import { removeCachedModel, ENTITLEMENT_RE } from "../discovery.mjs";
import { ALIVE_STATES } from "../runlog.mjs";
import { projectRun } from "../estimate.mjs";
import { isAgentless } from "../manifest.mjs";
import * as defaultWorktree from "../worktree.mjs";
import { runTask, classifyFailure, substituteTemplates } from "./run-task.mjs";
import { tryParseJson, enforceLeafContract } from "./leaf-contract.mjs";

// A codex leaf's first command is usually a batch, and past the model-visible cap codex
// shows the model only its first and last halves — the files it was told to read are
// simply not in it. So the plan is written to part files, each sized to arrive whole,
// and the leaf is told to run one command per call from the start. Paths resolve against
// the cwd the leaf actually RUNS in (its worktree), which is the only cwd its shell has.
function writeReadPlan(task, taskCwd, resultsDir, cfg, runner, writeFile = writeFileSync) {
  if (runner !== "codex" || !task.mustRead?.length) return { files: [], omitted: 0 };
  const { required } = resolveMustRead(task.mustRead, {
    cwd: taskCwd,
    substitute: (s) => substituteTemplates(s, resultsDir, cfg.resultInlineCap ?? 4000).prompt,
  });
  const parts = splitReadPlan(codexReadPlan(codexCoverable(required).required));
  const omitted = Math.max(0, parts.length - READS_PART_CEILING);
  const files = parts.slice(0, READS_PART_CEILING).map((lines, i) => {
    const path = join(resultsDir, "results", `${task.id}.reads-${i + 1}.txt`);
    const tmp = `${path}.tmp`;
    try {
      writeFile(tmp, lines.join("\n") + "\n");
      renameSync(tmp, path);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw e;
    }
    return path;
  });
  return { files, omitted };
}

export function createLaunch(ctx) {
  const { cfg, io, plan, tasks } = ctx;

  const launch = (task) => {
    ctx.record(task, "running");
    const promise = (async () => {
      // Ask mode: interrogate the recorded leaf in place. No worktree prepare,
      // no retry/fallback/digest — this is a single resumed dispatch, and the
      // leaf's own terminal state must never flip because the interrogation
      // itself failed (D8): the state recorded below is always "ok".
      if (ctx.ask && task.id === ctx.ask.taskId) {
        const prior = readResult(plan.resultsDir, task.id);
        // prior.model is what actually ran (post-fallback) and what askLeaf's
        // governance gate checked — task.model is only the manifest's ask.
        const model = ctx.ask.model || prior.model;
        const r = await runTask({
          ...task,
          cwd: prior.cwd,
          originalCwd: prior.originalCwd || task.originalCwd || prior.cwd,
          model,
          ...(ctx.ask.provider || task.provider || prior.provider ? { provider: ctx.ask.provider || task.provider || prior.provider } : {}),
          resume: prior.sessionId,
        }, ctx.ask.question, cfg, io, null, ctx.streamHooks(task), ctx.runtime);
        appendFileSync(join(plan.resultsDir, "results", `${task.id}.ask.log`), `Q: ${ctx.ask.question}\nA: ${r.output}\n\n`);
        const askEntry = {
          question: ctx.ask.question,
          answer: r.output,
          ok: r.ok,
          model,
          ...(r.provider && { provider: r.provider }),
          ...(r.runner && { runner: r.runner }),
          ...(tokenTotal(r.tokens) > 0 && { tokens: r.tokens }),
          ...(r.sessionId && { sessionId: r.sessionId }),
          ...(r.numTurns != null && { numTurns: r.numTurns }),
        };
        // The leaf's own identity is what it ran as; an override's identity lives on its ask entry.
        const updated = { ...prior, asks: [...(prior.asks || []), askEntry] };
        if (r.ok && r.sessionId) updated.sessionId = r.sessionId;
        writeResult(plan.resultsDir, task.id, updated);
        if (r.numTurns != null) ctx.turnsMap.set(task.id, (ctx.turnsMap.get(task.id) ?? 0) + r.numTurns);
        ctx.record(task, "ok", r.durationMs, r.tokens, r.ok ? undefined : `ask failed: ${r.output}`);
        return task.id;
      }
      if (task.outputDir) mkdirSync(task.outputDir, { recursive: true });
      // report mode drafts here; the prompt names it, so it must exist
      if (task.isDigest && plan.digest?.report) mkdirSync(digestScratchPath(plan.resultsDir), { recursive: true });

      // Resume a previously-failed leaf in place: an id rides to its own provider, past a turn.
      const prior = ctx.force ? null : readResult(plan.resultsDir, task.id);
      const recorded = ctx.recordedSessions.get(task.id);
      const resumeProvider = task.provider || prior?.provider || recorded?.provider;
      const minted = prior?.sessionId ? prior : recorded;
      const declined = minted?.provider && resumeProvider && minted.provider !== resumeProvider ? "provider-changed"
        : storedTurnCount(prior) === 0 ? "no-turns" : null;
      const resumeId = prior?.ok === true || declined ? null : (minted?.sessionId ?? null);

      let wt = null;
      let taskCwd = task.cwd;
      const wtName = ctx.nameOf(task);
      if (wtName !== undefined) {
        try {
          wt = ctx.worktree.prepareIsolation({ ...task, worktreeName: wtName }, cfg, plan.resultsDir, {
            reset: ctx.force && ctx.groupFirst.get(wtName) === task.id,
            addTimeoutMs: defaultWorktree.WORKTREE_ADD_TIMEOUT_MS,
            // The commit the run pinned at dispatch, not whatever HEAD says now.
            base: ctx.baseFor(task.originalCwd || task.cwd),
          });
          // Every tree-holding leaf sits at its declared depth. Unconditionally: the old
          // mode test skipped this for a hand-written tree and landed it at the root.
          taskCwd = defaultWorktree.treeCwd(wt.path, task.checkoutToplevel, task.originalCwd);
          if (wt.reused) appendRunLog(plan.resultsDir, {
            ts: new Date().toISOString(), event: "worktree-resume", id: task.id,
            reset: ctx.force, session: resumeId ? "resumed" : "fresh", ...(declined && { declined }),
          });
        } catch (e) {
          const result = { id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: false, exit: null, durationMs: 0, output: `worktree setup failed: ${e.message}` };
          writeResult(plan.resultsDir, task.id, result);
          ctx.record(task, "failed", 0);
          return task.id;
        }
      }

      // promptFinal is a forEach clone, substituted at clone time; the engine's
      // own notice rides last either way, and only once.
      const sub = task.promptFinal ? null : substituteTemplates(task.prompt, plan.resultsDir, cfg.resultInlineCap ?? 4000);
      const promptTruncations = sub ? sub.truncations : [];
      if (sub) ctx.notePromptTruncations(task, promptTruncations);
      const runner = ctx.durableIdentity(task).runner;
      let readPlan;
      try {
        readPlan = writeReadPlan(task, taskCwd, plan.resultsDir, cfg, runner, io.writeReadPlanFile);
      } catch (e) {
        const result = { id: task.id, model: task.model, ...ctx.durableIdentity(task), ok: false, exit: null, durationMs: 0, output: `read plan setup failed: ${e.message}` };
        writeResult(plan.resultsDir, task.id, result);
        ctx.record(task, "failed", 0);
        return task.id;
      }
      const prompt = withLeafNotices(sub ? sub.prompt : task.prompt, task, cfg, runner, readPlan.files, readPlan.omitted);
      // A leaf that failed only its schema, or only its coverage, is resumed on its
      // CORRECTION, not its prompt: re-sending the original makes it redo an
      // investigation it already finished. Keyed on the task definition — an edited
      // manifest is new spend — and on rawOutput, absent from rows written before it
      // was kept.
      const corrective = Boolean((prior?.schemaErrors?.length || prior?.coverageFailed) && prior.rawOutput != null
        && prior.key === taskKey(task) && resumeId);
      let r;
      if (corrective) {
        // Built field by field, never spread from prior: the failure's errors, cost
        // and turns must not ride into a recovered row.
        r = await enforceLeafContract(task, {
          ok: true, exit: prior.exit, output: prior.rawOutput, sessionId: resumeId,
          provider: prior.provider, runner: prior.runner,
          ...(prior.modelAlias && { realModel: prior.model }),
          tokens: emptyTokens(), durationMs: 0,
        }, taskCwd, plan.resultsDir, cfg, io, ctx.streamHooks(task), ctx.runtime, runTask);
      } else {
        // Resume appends: a resumed leaf's session holds every earlier Read, so its
        // transcript must too (coverage checks the whole attempt history). A fresh
        // run (or --force) truncates.
        const leafLog = createWriteStream(join(plan.resultsDir, "results", `${task.id}.log`), resumeId ? { flags: "a" } : {});
        r = await runTask({
          ...task, cwd: taskCwd,
          ...(resumeId && { resume: resumeId }),
          ...(resumeProvider && { provider: resumeProvider }),
        }, prompt, cfg, io, leafLog, ctx.streamHooks(task), ctx.runtime);
        if ((task.returns || task.mustRead) && r.ok) {
          r = await enforceLeafContract(task, r, taskCwd, plan.resultsDir, cfg, io, ctx.streamHooks(task), ctx.runtime, runTask);
        }
      }

      // Claude leaves record the REAL model id (from the init event) with the
      // manifest alias kept as modelAlias — grade rows resolve model from here.
      // Non-Claude models keep the manifest name verbatim: ':cloud' is a
      // routing/governance identity an init-reported bare name must not clobber.
      const stamped = r.realModel && isClaudeModel(task.model) && r.realModel !== task.model;
      const resultIdentity = task.provider !== undefined
        ? { provider: r.provider || ctx.resolvedIdentity(task).provider, runner: r.runner || ctx.providerRegistry.get(r.provider || ctx.resolvedIdentity(task).provider).runnerId }
        : {};
      const result = {
        id: task.id,
        model: stamped ? r.realModel : task.model,
        ...resultIdentity,
        ...(stamped && { modelAlias: task.model }),
        ok: r.ok,
        exit: r.exit,
        durationMs: r.durationMs,
        prompt, // the exact string sent — with the snapshot, the leaf's full intent
        output: r.errorCode === "schema_error"
          ? `structured output rejected by the runner after its retries (schema_error)\n${r.output}`
          : r.output,
        // A drill-down straight to results/<id>.json must see that this leaf's
        // input was cut — the run-level warning is easy to skip past.
        ...(promptTruncations.length && { promptTruncations }),
      };
      if (tokenTotal(r.tokens) > 0) result.tokens = r.tokens;
      if (r.costUsd != null) result.costUsd = r.costUsd;
      if (r.numTurns != null) result.numTurns = r.numTurns;
      // interrogation fields: `swarm ask` resumes this session in this cwd;
      // originalCwd (pre worktree redirect) is the governance identity
      if (r.sessionId) result.sessionId = r.sessionId;
      if (r.schemaRetried) result.schemaRetried = true;
      if (r.schemaErrors) result.schemaErrors = r.schemaErrors;
      // The leaf's own output on a schema failure — what a re-run re-asks from.
      if (r.rawOutput != null) result.rawOutput = r.rawOutput;
      if (r.citations) result.citations = r.citations;
      // Refuted citations are KEPT and annotated, never a failure. Loud
      // per-leaf (in the result) and run-level (the closing block) — a kept-but-
      // unverified finding must read as exactly that, never as verified.
      if (r.citationRefuted?.length) {
        result.citationRefuted = r.citationRefuted;
        ctx.refutations.push({ id: task.id, refuted: r.citationRefuted.length, total: r.citations.checked + r.citations.refuted });
      }
      // Coverage rides the same rail as refutations: recorded on the result, and —
      // when short — pushed to the run-level list the closing block prints loud.
      if (r.coverage) {
        result.coverage = r.coverage;
        // The zero-engagement flag must ride the run-level entry too — the closing
        // block keys its red line off the entry, not off the result file.
        if (r.coverage.status !== "complete") {
          ctx.coverageGaps.push({ id: task.id, ...r.coverage, ...(r.coverageFailed && { coverageFailed: true }) });
        }
      }
      // A leaf that engaged with nothing it was required to read. Not a shortfall to
      // annotate: it never did the task. What a corrective re-run re-asks from.
      if (r.coverageFailed) result.coverageFailed = true;
      result.cwd = taskCwd;
      result.originalCwd = task.originalCwd;
      if (task.checkoutToplevel) result.checkoutToplevel = task.checkoutToplevel;
      result.allowedTools = task.allowedTools;

      // Semantic contract failures bypass transcript classification; a stray 429 cannot retry them.
      // A memory stop is checked first because the valve may kill without a classifiable message.
      // The !r.ok guard handles a racing stop after the leaf exits.
      const isMemoryStop = ctx.memoryStopped.has(task.id) && !r.ok;
      ctx.memoryStopped.delete(task.id);
      const st = isMemoryStop ? "memory"
        : r.ok ? "ok"
        : r.schemaErrors || r.coverageFailed || r.errorCode === "schema_error" ? "failed"
        : classifyFailure({ timedOut: r.timedOut, output: r.raw, stopped: ctx.stopRequested }, cfg.quotaPatterns);
      if (isMemoryStop) {
        // runTask's generic mid-stream message tells a reader not to kill or
        // diff-hunt — exactly backwards here, where the kill was deliberate.
        result.output = result.output.replace(
          /leaf terminated mid-stream \(no (?:end_turn|terminal event)\)[^\n]*\n?/,
          "leaf stopped for low memory — parked; the engine resumes it automatically once memory recovers.\n",
        );
      }
      // The terminal state is machinery, not a verdict on the model: record it
      // so `grade --init` pre-fills an infra outcome instead of `failed`. A
      // retry or a fallback rewrites the whole result, so a leaf that recovered
      // never carries the class of the attempt it recovered from.
      if (st === "quota" || st === "rate-limited") result.failureClass = st;
      if (st === "quota") {
        const resetsAt = parseQuotaReset(r.raw);
        if (resetsAt) result.quotaResetsAt = resetsAt;
      }
      // A 402 extra-usage failure means the account can't run this model:
      // drop it from the models cache so the roster stops offering it. The
      // classification stays "failed" — entitlement is roster metadata, not a
      // retry class — and the next `models` refresh restores the row if the
      // probe stops 402ing.
      if (!r.ok && ENTITLEMENT_RE.test(r.raw || "")) removeCachedModel(task.model, io.env, task.provider);
      const parsed = tryParseJson(r.output);
      if (parsed !== undefined) result.outputJson = parsed;

      if (wt && ctx.groupFinal.get(wtName) === task.id) {
        const isChainFollower = (ctx.groupMembers.get(wtName)?.length ?? 1) > 1;
        const collected = ctx.worktree.collect(task, cfg, wt, {
          isChainFollower,
          isIntegrateSource: ctx.isIntegrateSourceId(task.id),
        });
        result.worktree = collected;
        if (collected.kept) ctx.worktreesKept.push({
          name: wt.name ?? wtName, branch: collected.branch,
          path: collected.path, diffstat: collected.diffstat,
          taskIds: ctx.groupMembers.get(wtName),
        });
      } else if (wt) {
        // Mid-chain link: record where it worked, leave the tree for its successor.
        result.worktree = { kept: true, branch: wt.branch, path: wt.path, name: wt.name, pending: true };
      }

      writeTaskResult(plan.resultsDir, task, result);

      // Every attempt's turns are requests the meter charged, a retried or parked one included.
      if (r.numTurns != null) ctx.turnsMap.set(task.id, (ctx.turnsMap.get(task.id) ?? 0) + r.numTurns);

      // D4/D5: land the valve's kill as a park, not a retry — it never
      // touches attempts, so it can never exhaust a leaf's retry budget.
      if (isMemoryStop) {
        ctx.parkForMemory(task);
        return task.id;
      }

      if (!r.ok) {
        const retry = cfg.retry || {};
        const n = ctx.attempts.get(task.id) || 0;
        // transient failures retry in-run with backoff; spawn errors (exit
        // null, not killed) get one immediate-ish retry for environment flakes
        if (st === "rate-limited" && n < (retry.rateLimited ?? 2)) {
          ctx.attempts.set(task.id, n + 1);
          const delay = (retry.backoffMs ?? 30000) * Math.pow(3, n);
          ctx.scheduleRetry(task, delay, `↻ retry ${n + 1}/${retry.rateLimited ?? 2} in ${Math.round(delay / 1000)}s`);
          return task.id;
        }
        // ENAMETOOLONG is a deterministic argv-size failure (win32 command-line
        // cap) — retrying it burns a slot on a leaf that will fail identically.
        if (st === "failed" && r.exit === null && !r.timedOut && r.errorCode !== "ENAMETOOLONG" && n < (retry.spawnError ?? 1)) {
          ctx.attempts.set(task.id, n + 1);
          ctx.scheduleRetry(task, 2000, "↻ retry after spawn error");
          return task.id;
        }
        // quota (immediately) or exhausted rate-limit retries: one switch to
        // the manifest-declared fallback — the engine never substitutes a
        // model the user didn't approve
        if ((st === "quota" || st === "rate-limited") && task.fallbackModel && !ctx.usedFallback.has(task.id)) {
          ctx.usedFallback.add(task.id);
          const from = { provider: r.provider || ctx.resolvedIdentity(task).provider, model: task.model };
          const target = {
            model: task.fallbackModel,
            ...(task.fallbackProvider !== undefined && { provider: task.fallbackProvider }),
          };
          let next, rejected;
          try {
            next = ctx.resolvedIdentity(target);
            const problems = ctx.providerRegistry.get(next.provider).validateTask({ ...task, ...next }, { config: cfg, task });
            if (problems?.length) rejected = problems.join("; ");
          } catch (e) {
            rejected = e.message;
          }
          // A rejected fallback ends only this leaf, in its real quota state; the run carries on.
          if (rejected) {
            appendRunLog(plan.resultsDir, {
              ts: new Date().toISOString(), id: task.id, event: "fallback-rejected",
              fromProvider: from.provider, toProvider: next?.provider ?? target.provider, toModel: target.model, reason: rejected,
            });
          } else {
            appendRunLog(plan.resultsDir, {
              ts: new Date().toISOString(), id: task.id, event: "fallback",
              from: from.model, to: next.model,
              fromProvider: from.provider, toProvider: next.provider,
              fromModel: from.model, toModel: next.model,
            });
            task.model = next.model;
            task.provider = next.provider;
            ctx.attempts.set(task.id, 0);
            ctx.scheduleRetry(task, 10, `↯ fallback → ${task.provider}/${task.model}`);
            return task.id;
          }
        }
        // terminal quota: pre-emptively fail-fast every still-pending leaf in
        // the same provider/applicable limit scope without a fallback — one
        // failure, one lesson. Unrelated providers continue independently.
        if (st === "quota") {
          const current = ctx.resolvedIdentity(task);
          const familyOf = (model) => String(model || "").match(/(fable|opus|sonnet|haiku)/i)?.[1]?.toLowerCase() || "";
          // A mid-run transcript without a named family is a provider-wide
          // quota bucket; a transcript that names one family stays scoped.
          const quotaFamily = familyOf(r.raw);
          for (const t of tasks) {
            if (isAgentless(t) || ctx.state.get(t.id) !== "pending" || t.fallbackModel) continue;
            const candidate = ctx.resolvedIdentity(t);
            const sameScope = candidate.provider === current.provider && (
              current.provider !== "claude" || !quotaFamily || quotaFamily === familyOf(t.model)
            );
            if (sameScope) {
              ctx.record(t, "quota");
            }
          }
        }
      }

      if (task.isDigest) {
        if (r.ok) ctx.digestPath = writeDigestMd(plan.resultsDir, r.output);
        else ctx.digestFailed = true;
      }

      ctx.record(task, st, r.durationMs, r.tokens);

      // Projection warn: this leaf is terminal (retry/fallback paths returned
      // above). Track spend, project over the worst-case remainder, warn once.
      const realKey = r.apiKeySource != null && r.apiKeySource !== "none";
      if (r.costUsd != null && realKey) ctx.costMap.set(task.id, r.costUsd);
      ctx.completedLeaves++;
      ctx.spentTokens += workTokens(r.tokens || emptyTokens());
      ctx.spentUsd += r.costUsd ?? 0;
      ctx.costIsRealComplete &&= r.costUsd != null && realKey;
      if (cfg.costWarn !== false && !ctx.costWarnFired) {
        const remaining = tasks.reduce((n, t) => {
          if (isAgentless(t) || t.aggregate || t.aggregateManifest || !ALIVE_STATES.has(ctx.state.get(t.id))) return n;
          const mult = t.forEach ? t.forEach.maxItems : 1;
          if (t.childPlan) return n + mult * t.childPlan.tasks.filter((c) => !isAgentless(c)).length;
          return n + mult;
        }, 0);
        const useUsd = ctx.costIsRealComplete && ctx.spentUsd > 0;
        const threshold = useUsd ? (cfg.costWarnUsd ?? 10) : (cfg.costWarnTokens ?? 5_000_000);
        const projected = projectRun({ spent: useUsd ? ctx.spentUsd : ctx.spentTokens, completed: ctx.completedLeaves, remaining });
        if (projected != null && projected >= threshold) {
          ctx.costWarnFired = true;
          const fmt = useUsd ? (n) => `$${n.toFixed(2)}` : (n) => `${formatTokens(n)} tokens`;
          const text = `⚠ projected ~${fmt(projected)} for this run (threshold ${fmt(threshold)}) — ${ctx.completedLeaves}/${ctx.completedLeaves + remaining} leaves done`;
          io.stdout(text);
          appendRunLog(plan.resultsDir, { ts: new Date().toISOString(), event: "cost-warn", unit: useUsd ? "usd" : "tokens", projected, threshold });
          io.notify?.(text);
        }
      }
      return task.id;
    })().finally(() => { ctx.running.delete(task.id); ctx.children.delete(task.id); });
    ctx.running.set(task.id, promise);
  };

  return { launch };
}
