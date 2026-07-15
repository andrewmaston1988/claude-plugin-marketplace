// Leaf interrogation: resume a finished leaf's session and ask a follow-up.
// The leaf already holds its file reads and reasoning in context, so a
// drill-down costs one turn instead of a re-run. Same model, same cwd, same
// tool allowlist as the original dispatch — a read-only leaf stays read-only
// under questioning.
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./config.mjs";
import { readResult, writeResult } from "./results.mjs";
import { isClaudeModel } from "./models.mjs";
import { isUnderRoot } from "./manifest.mjs";
import { runTask, makeDefaultIo } from "./scheduler.mjs";

export async function askLeaf({ resultsDir, taskId, question, model, cfg, io = makeDefaultIo() }) {
  const prior = readResult(resultsDir, taskId);
  if (!prior) throw new Error(`no result for '${taskId}' under ${resultsDir}`);
  if (!prior.sessionId) {
    throw new Error(`result for '${taskId}' has no sessionId — the run predates session capture; re-run the plan to enable interrogation`);
  }
  const cwd = prior.cwd;
  if (!cwd || !existsSync(cwd)) {
    throw new Error(`leaf cwd '${cwd}' no longer exists (removed worktree?) — the session cannot be resumed`);
  }
  const askModel = model || prior.model;
  // Same deny-by-default gate as the manifest: a non-Claude model may only see
  // code under an allow-listed root, whether it got here by override or not.
  // Checked against the leaf's ORIGINAL cwd — the identity the manifest gate
  // approved — not the scratch/worktree redirect it executed in.
  if (!isClaudeModel(askModel)) {
    const govCwd = prior.originalCwd || cwd;
    const roots = cfg?.provider?.allowedRoots || [];
    if (!roots.some((root) => isUnderRoot(govCwd, root))) {
      throw new Error(
        `governance: model '${askModel}' is not a Claude model and '${govCwd}' is not under any provider.allowedRoots entry`
      );
    }
  }

  const task = {
    id: taskId,
    model: askModel,
    allowedTools: prior.allowedTools || "Read,Grep,Glob",
    cwd,
    resume: prior.sessionId,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const r = await runTask(task, question, cfg, io, null, {});
  if (!r.ok) throw new Error(`ask failed (exit ${r.exit}): ${r.raw.slice(0, 500)}`);

  // Resume forks a new session id; adopt it so the next ask continues THIS
  // conversation thread rather than restarting from the original leaf state.
  if (r.sessionId && r.sessionId !== prior.sessionId) {
    prior.sessionId = r.sessionId;
    writeResult(resultsDir, taskId, prior);
  }
  appendFileSync(
    join(resultsDir, "results", `${taskId}.ask.log`),
    `## Q ${new Date().toISOString()}\n${question}\n\n## A\n${r.output}\n\n`
  );
  return { answer: r.output, tokens: r.tokens, sessionId: r.sessionId ?? prior.sessionId };
}
