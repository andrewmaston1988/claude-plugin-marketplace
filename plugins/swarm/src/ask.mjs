// Leaf interrogation: resume a finished leaf's session and ask a follow-up.
// The leaf already holds its file reads and reasoning in context, so a
// drill-down costs one turn instead of a re-run. Same model, same cwd, same
// tool allowlist as the original dispatch — a read-only leaf stays read-only
// under questioning.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./config.mjs";
import { DIGEST_ID } from "./digest.mjs";
import { defaultToolsFor, mcpTools, worktreeNameFromCwd } from "./manifest-task-policy.mjs";
import { readResult } from "./results.mjs";
import { cwdAllowed, defaultGovernanceIo } from "./governance.mjs";
import { allowedRootsFor, providerConfig } from "./providers.mjs";
import { defaultProviderRegistry } from "./default-providers.mjs";
import { runPlan, makeDefaultIo } from "./scheduler.mjs";
import { claimEngine, releaseEngine, lockRefusal } from "./engine-lock.mjs";

const PROVIDERS = defaultProviderRegistry();

export async function askLeaf({ resultsDir, taskId, question, model, provider, cfg, io = makeDefaultIo(), providerRegistry = PROVIDERS, runnerRegistry, _governanceIo = defaultGovernanceIo(), _mcpTools = mcpTools }) {
  const prior = readResult(resultsDir, taskId);
  if (!prior) throw new Error(`no result for '${taskId}' under ${resultsDir}`);
  if (!prior.sessionId) {
    throw new Error(`result for '${taskId}' has no sessionId — the run predates session capture; re-run the plan to enable interrogation`);
  }
  // A reader's cwd is the live repo and is still there; only a writer's tree can have been
  // reaped, and only when it changed nothing. Nothing is re-created here — that re-add was
  // also what made `run` collide with itself after a `stop`.
  const cwd = prior.cwd;
  if (!cwd || !existsSync(cwd)) {
    if (prior.worktree) {
      throw new Error(`the leaf's worktree was removed because it changed nothing; re-run the leaf to ask it again`);
    }
    throw new Error(`leaf cwd '${cwd}' no longer exists — the session cannot be resumed`);
  }
  const askModel = model || prior.model;
  const manifest = JSON.parse(readFileSync(join(resultsDir, "manifest.json"), "utf8"));
  const recordedTask = manifest.tasks.find((t) => t.id === taskId);
  const recordedProvider = !model ? (prior.provider || recordedTask?.provider) : undefined;
  const identity = providerRegistry.resolve(
    { model: askModel, ...(provider || recordedProvider ? { provider: provider || recordedProvider } : {}) },
    { config: cfg },
  );
  const adapter = providerRegistry.get(identity.provider);
  const problems = adapter.validateTask({ model: askModel, provider: identity.provider }, { config: cfg });
  if (problems?.length) throw new Error(`provider '${identity.provider}' rejected ask: ${problems.join("; ")}`);
  // Same deny-by-default gate as the manifest, and for EVERY provider including Claude:
  // an ask does not reload the manifest, so this is the only root check on the path.
  // Checked against the leaf's ORIGINAL cwd — the identity the manifest gate approved —
  // not the worktree redirect it executed in.
  {
    const govCwd = prior.originalCwd || cwd;
    const { roots, deniedBy } = allowedRootsFor(cfg, identity.provider);
    if (!cwdAllowed(govCwd, roots || [], _governanceIo)) {
      throw new Error(
        `governance: provider '${identity.provider}' model '${askModel}' and '${govCwd}' is not under any ${deniedBy} entry`
      );
    }
  }

  // The manifest snapshot is the effective plan at dispatch, but it's a
  // stripped RECORD (effectivePlanDoc drops empty `after`, and `timeoutMs`
  // entirely) — not input-ready. Every task needs `after` back so the
  // scheduling loop can read it; the target additionally needs the dispatch
  // fields the snapshot never carried, sourced from its own last result.
  const isTopLevel = manifest.tasks.some((t) => t.id === taskId);
  // The tree the leaf actually ran in, recovered from its own result: the manifest
  // snapshot records `workspace` but no tree name, and a clone's id (`fix[0]`) is
  // not its tree (`fix-0`). Rebuilding the ask task without it pointed the write
  // guard at `wt-fix[0]`, a tree that never existed, denying every write.
  const treeName = worktreeNameFromCwd(prior.cwd, resultsDir);
  // A forEach clone (`fix[0]`) or manifest child (`node~child`) never appears in
  // manifest.tasks — it joined the roster mid-run via an expand event. Its own
  // result carries every field a manifest task would have declared, so build the
  // ask task from that instead of requiring a manifest entry that doesn't exist.
  // A result recorded before `allowedTools` was captured — or a hand-built task —
  // falls back to the same runner-dependent default normalize would have filled in,
  // so an ask keeps the confinement the original dispatch ran under.
  const fallbackTools = defaultToolsFor(identity.provider, _mcpTools());
  const tasks = isTopLevel
    ? manifest.tasks.map((t) => (t.id === taskId
        ? { ...t, ...(treeName !== undefined && { worktreeName: treeName }), after: t.after || [], provider: identity.provider, allowedTools: prior.allowedTools || fallbackTools, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS }
        : { ...t, after: t.after || [] }))
    : [
        ...manifest.tasks.map((t) => ({ ...t, after: t.after || [] })),
        {
          id: taskId,
          model: prior.model,
          provider: identity.provider,
          cwd: prior.cwd,
          originalCwd: prior.originalCwd || prior.cwd,
          allowedTools: prior.allowedTools || fallbackTools,
          timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          after: [],
          ...(treeName !== undefined && { worktreeName: treeName }),
          // The digest's cwd is engine scratch, outside every tree; without this the
          // id fallback would name `wt-__digest` and deny every write it makes there.
          ...(taskId === DIGEST_ID && { isDigest: true }),
        },
      ];
  // An ask drives the same resultsDir a run does, so it takes the same claim: two
  // asks, or an ask against a run still in its pre-heartbeat startup, are otherwise
  // one engine each. Released on every exit — runPlan's own throws included.
  const claimed = claimEngine(resultsDir, { heartbeatMs: Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000) });
  if (!claimed.ok) throw new Error(lockRefusal(resultsDir, claimed.pid, "asking"));
  try {
  // An ask is a one-off answer, not a monitored run: no roster/live-view
  // frames, only the CLI's own answer + tokens line. Suppressing io.snapshot
  // is what runPlan's paint() checks before rendering anything.
  await runPlan({ ...manifest, tasks, concurrency: 1 }, cfg, { ...io, snapshot: undefined }, {
    providerRegistry,
    runnerRegistry,
    ask: { taskId, question, model: askModel, provider: identity.provider },
  });

  const updated = readResult(resultsDir, taskId);
  const askEntry = updated.asks[updated.asks.length - 1];
  return {
    answer: askEntry.answer,
    tokens: askEntry.tokens,
    model: askEntry.model,
    ...(askEntry.numTurns != null && { numTurns: askEntry.numTurns }),
    sessionId: updated.sessionId,
    ok: askEntry.ok,
    ...(askEntry.provider && { provider: askEntry.provider }),
    ...(askEntry.runner && { runner: askEntry.runner }),
  };
  } finally {
    releaseEngine(resultsDir);
  }
}
