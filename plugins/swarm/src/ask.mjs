// Leaf interrogation: resume a finished leaf's session and ask a follow-up.
// The leaf already holds its file reads and reasoning in context, so a
// drill-down costs one turn instead of a re-run. Same model, same cwd, same
// tool allowlist as the original dispatch — a read-only leaf stays read-only
// under questioning.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./config.mjs";
import { readResult } from "./results.mjs";
import { isUnderRoot } from "./roots.mjs";
import { createDefaultProviderRegistry, providerConfig } from "./providers.mjs";
import { defaultCodexProviderAdapter } from "./codex.mjs";
import { runPlan, makeDefaultIo } from "./scheduler.mjs";

const PROVIDERS = createDefaultProviderRegistry({ codexAdapter: defaultCodexProviderAdapter });

export async function askLeaf({ resultsDir, taskId, question, model, provider, cfg, io = makeDefaultIo() }) {
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
  const manifest = JSON.parse(readFileSync(join(resultsDir, "manifest.json"), "utf8"));
  const recordedTask = manifest.tasks.find((t) => t.id === taskId);
  const recordedProvider = !model ? (prior.provider || recordedTask?.provider) : undefined;
  const identity = PROVIDERS.resolve(
    { model: askModel, ...(provider || recordedProvider ? { provider: provider || recordedProvider } : {}) },
    { config: cfg },
  );
  const adapter = PROVIDERS.get(identity.provider);
  const problems = adapter.validateTask({ model: askModel, provider: identity.provider }, { config: cfg });
  if (problems?.length) throw new Error(`provider '${identity.provider}' rejected ask: ${problems.join("; ")}`);
  // Same deny-by-default gate as the manifest: a non-Claude model may only see
  // code under an allow-listed root, whether it got here by override or not.
  // Checked against the leaf's ORIGINAL cwd — the identity the manifest gate
  // approved — not the scratch/worktree redirect it executed in.
  if (identity.provider !== "claude") {
    const govCwd = prior.originalCwd || cwd;
    const roots = providerConfig(cfg, identity.provider).allowedRoots || [];
    if (!roots.some((root) => isUnderRoot(govCwd, root))) {
      throw new Error(
        `governance: provider '${identity.provider}' model '${askModel}' and '${govCwd}' is not under any allowedRoots entry`
      );
    }
  }

  // The manifest snapshot is the effective plan at dispatch, but it's a
  // stripped RECORD (effectivePlanDoc drops empty `after`, and `timeoutMs`
  // entirely) — not input-ready. Every task needs `after` back so the
  // scheduling loop can read it; the target additionally needs the dispatch
  // fields the snapshot never carried, sourced from its own last result.
  const isTopLevel = manifest.tasks.some((t) => t.id === taskId);
  // A forEach clone (`fix[0]`) or manifest child (`node~child`) never appears in
  // manifest.tasks — it joined the roster mid-run via an expand event. Its own
  // result carries every field a manifest task would have declared, so build the
  // ask task from that instead of requiring a manifest entry that doesn't exist.
  const tasks = isTopLevel
    ? manifest.tasks.map((t) => (t.id === taskId
        ? { ...t, after: t.after || [], provider: identity.provider, allowedTools: prior.allowedTools || "Read,Grep,Glob", timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS }
        : { ...t, after: t.after || [] }))
    : [
        ...manifest.tasks.map((t) => ({ ...t, after: t.after || [] })),
        {
          id: taskId,
          model: prior.model,
          provider: identity.provider,
          cwd: prior.cwd,
          originalCwd: prior.originalCwd || prior.cwd,
          allowedTools: prior.allowedTools || "Read,Grep,Glob",
          scratchRedirect: false,
          timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          after: [],
        },
      ];
  // An ask is a one-off answer, not a monitored run: no roster/live-view
  // frames, only the CLI's own answer + tokens line. Suppressing io.snapshot
  // is what runPlan's paint() checks before rendering anything.
  await runPlan({ ...manifest, tasks, concurrency: 1 }, cfg, { ...io, snapshot: undefined }, {
    ask: { taskId, question, model: askModel, provider: identity.provider },
  });

  const updated = readResult(resultsDir, taskId);
  const askEntry = updated.asks[updated.asks.length - 1];
  return { answer: askEntry.answer, tokens: askEntry.tokens, sessionId: updated.sessionId, ok: askEntry.ok };
}
