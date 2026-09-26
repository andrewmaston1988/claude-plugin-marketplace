// ── shared normalization ──────────────────────────────────────────────────────
// Every task, Claude included, passes the governance gate (governance.mjs): it may
// run only under the allow-listed roots, checked against its ORIGINAL effective cwd
// (before any scratch redirect).

import { resolve } from "node:path";
import { CONTEXT_WINDOW_1M } from "./contracts.mjs";
import { declaredEfforts, effortFor } from "./models.mjs";
import { providerConfig } from "./providers.mjs";
import { runScopeKey } from "./worktree.mjs";
import { applyWriteGuard } from "../hooks/leaf-write-guard.mjs";
import { checkGovernance } from "./governance.mjs";
import { DEFAULT_TOOLS, hasWriteTools, resolveWorktreeName, leafWriteGuardRoots } from "./manifest-task-policy.mjs";
import { guardFor, probeGuard, defaultManifestIo } from "./manifest-leaf-guard.mjs";
import { PROVIDERS, checkDenylist, checkHeadroom, resolveProvider, validateEffort } from "./manifest-model-gates.mjs";

export function normalizeTasks(rawTasks, { cwd, resultsDir, cfg, defaultTimeoutMs, errors, label, childPlans, headroom, warnings, cache = [], io = defaultManifestIo(), probedGuards = new Set(), providerRegistry = PROVIDERS }) {
  // Many tasks share a cwd; ask git once per directory.
  const tops = new Map();
  const repoTop = (dir) => {
    if (!tops.has(dir)) tops.set(dir, io.checkoutToplevel(dir));
    return tops.get(dir);
  };
  return rawTasks.map((t) => {
    const l = label(t);
    const isCompute = t.compute !== undefined;
    const isIntegrate = t.integrate !== undefined;
    const isManifest = t.manifest !== undefined;
    const originalCwd = t.cwd ? resolve(cwd, t.cwd) : cwd;
    // compute/manifest nodes spawn nothing themselves and no code leaves the
    // machine — no governance, no isolation.
    let provider;
    let fallbackProvider;
    let primaryDeclared;
    let resolvedEffort;
    if (!isCompute && !isManifest && !isIntegrate) {
      const primary = resolveProvider({ ...t }, cfg, cache, l, errors, providerRegistry);
      provider = primary?.provider;
      if (provider) {
        primaryDeclared = declaredEfforts(t.model, provider, cache);
        resolvedEffort = effortFor(t, primaryDeclared);
        validateEffort(t.model, provider, resolvedEffort, primaryDeclared, l, errors);
      }
      if (t.contextWindow === CONTEXT_WINDOW_1M && provider === "ollama" && providerConfig(cfg, "ollama").mode === "launch") {
        errors.push(`${l}: contextWindow "1m" is unsupported with Ollama launch mode because the launcher rejects [1m] model names — use env mode or remove contextWindow`);
      }
      if (t.contextWindow !== undefined && provider === "codex") {
        errors.push(`${l}: Codex tasks do not support contextWindow; "1m" is a Claude CLI model-name suffix`);
      }
      if (provider) checkGovernance(provider, t.model, originalCwd, l, cfg, errors);
      checkDenylist(t.model, l, cfg, errors);
      if (provider) checkHeadroom(provider, t.model, l, headroom, errors, warnings);
      if (t.fallbackModel !== undefined) {
        if (typeof t.fallbackModel !== "string" || !t.fallbackModel) {
          errors.push(`${l}: fallbackModel must be a model name string`);
        } else {
          // The fallback is a real dispatch target with its own provider — a Claude
          // primary must not force a Codex/Ollama fallback, and nothing is inferred.
          if (t.fallbackProvider === undefined) {
            errors.push(`${l}: fallbackModel '${t.fallbackModel}' has no "fallbackProvider" — add it beside "fallbackModel", e.g. "fallbackModel": "claude-haiku-4-5-20251001", "fallbackProvider": "claude"`);
          } else {
            const fallback = resolveProvider({ model: t.fallbackModel, provider: t.fallbackProvider }, cfg, cache, `${l} fallback`, errors, providerRegistry);
            fallbackProvider = fallback?.provider;
            if (fallbackProvider) {
              // The effort pinned for the primary is sent to the fallback too, so it
              // must satisfy whatever the fallback's own provider declares.
              if (resolvedEffort !== undefined) {
                validateEffort(t.fallbackModel, fallbackProvider, resolvedEffort,
                  declaredEfforts(t.fallbackModel, fallbackProvider, cache), `${l} fallback`, errors);
              }
              checkGovernance(fallbackProvider, t.fallbackModel, originalCwd, `${l} fallback`, cfg, errors);
              checkHeadroom(fallbackProvider, t.fallbackModel, `${l} fallback`, headroom, errors, warnings);
            }
          }
          checkDenylist(t.fallbackModel, `${l} fallback`, cfg, errors);
        }
      } else if (t.fallbackProvider !== undefined) {
        errors.push(`${l}: fallbackProvider without fallbackModel — remove it, or add the "fallbackModel" it belongs to`);
      }
    }
    // compute/manifest/integrate spawn no leaf, so no guard applies. An opted-out
    // task only gets the "off" line when a guard would otherwise have applied —
    // opting out of nothing is not worth reporting.
    let guard;
    if (!isCompute && !isManifest && !isIntegrate) {
      const resolved = guardFor(originalCwd, cfg, io);
      if (t.leafGuard === false) {
        if (resolved) io.stdout(`leaf guard: off (task opt-out)`);
      } else if (resolved && provider === "codex") {
        errors.push(`${l}: provider 'codex' cannot run a configured leaf guard; set leafGuard: false for this task`);
      } else if (resolved) {
        guard = resolved;
        probeGuard(guard, originalCwd, l, io, probedGuards, errors);
        io.stdout(`leaf guard: ${guard.name} → ${guard.command}`);
      }
    }
    // ONE derivation, for every leaf. A leaf that can write gets a tree; a leaf that
    // cannot reads the live repo where it was pointed. There is no second branch for an
    // explicitly-spelled tree, because there is no explicit spelling: that split is what
    // left `isolationMode`, `branchScope` and `checkoutToplevel` unset on every hand-written
    // `"isolation": "worktree"`, landing the leaf at its tree root instead of its depth.
    let checkoutToplevel;
    let branchScope;
    if (!isCompute && !isManifest && !isIntegrate && hasWriteTools(t.allowedTools)) {
      const top = repoTop(originalCwd);
      if (!top) {
        errors.push(
          `${l}: task cwd '${originalCwd}' is not inside a git repository, so it cannot get a worktree — ` +
          `point cwd into a repo, or drop the write tools and read it in place (e.g. "allowedTools": "Read,Grep,Glob")`);
      } else {
        checkoutToplevel = top;
        // Run-scoped branch: a kept tree from an earlier run of this manifest must not
        // block this one. An explicit `branch` opts out by naming a stable one instead —
        // that is what naming it means, so the author owns the collision.
        if (!t.branch) branchScope = runScopeKey(resultsDir);
      }
    }
    const worktreeName = isIntegrate ? t.integrate.into : resolveWorktreeName(t);
    const branchName = (isCompute || isManifest) ? undefined : t.branch;
    const whenBlock = t.when && typeof t.when === "object" && !Array.isArray(t.when)
      ? { when: { from: t.when.from, expr: t.when.expr } } : {};
    const forEachBlock = !isCompute && t.forEach && typeof t.forEach === "object" && !Array.isArray(t.forEach)
      ? { forEach: { from: t.forEach.from, path: t.forEach.path ?? "", maxItems: t.forEach.maxItems } } : {};
    const outputDir = t.outputDir ? resolve(cwd, t.outputDir) : undefined;
    // `--allowedTools` scopes tool NAMES, never paths, and a worktree confines only the
    // leaf's cwd — so a PreToolUse guard is merged into each writer's own `--settings`.
    // Codex is skipped deliberately: its adapter refuses any settings at all, so
    // attaching one would fail the leaf on a message about Claude-only settings, and a
    // Codex leaf never runs the Claude Code hook machinery the guard rides.
    const guardRoots = !isCompute && !isManifest && !isIntegrate && provider !== "codex" && hasWriteTools(t.allowedTools)
      ? leafWriteGuardRoots({ worktreeName, resultsDir, outputDir })
      : [];
    const taskSettings = guardRoots.length ? applyWriteGuard(t.settings, guardRoots) : t.settings;
    return {
      id: t.id,
      prompt: isCompute || isManifest || isIntegrate ? "" : t.prompt,
      // "compute"/"manifest" are display sentinels, never dispatched — these
      // nodes run inline in the engine (the scheduler excludes them from
      // preflights; a manifest node expands into its child's tasks).
      model: isManifest ? "manifest" : isCompute ? "compute" : isIntegrate ? "integrate" : t.model,
      ...(!isCompute && !isManifest && !isIntegrate && { provider }),
      fallbackModel: !isCompute && !isManifest && typeof t.fallbackModel === "string" ? t.fallbackModel : undefined,
      ...(!isCompute && !isManifest && !isIntegrate && fallbackProvider && { fallbackProvider }),
      effort: isCompute || isManifest || isIntegrate ? undefined : resolvedEffort,
      allowedTools: isCompute || isManifest || isIntegrate ? "" : t.allowedTools || DEFAULT_TOOLS,
      cwd: originalCwd,
      originalCwd,
      ...(checkoutToplevel !== undefined && { checkoutToplevel }),
      ...(branchScope !== undefined && { branchScope }),
      ...(t.workspace !== undefined && { workspace: t.workspace }),
      ...(worktreeName !== undefined && { worktreeName }),
      ...(isIntegrate && { integrate: { into: t.integrate.into, from: [...t.integrate.from] } }),
      ...(branchName !== undefined && { branchName }),
      outputDir,
      timeoutMs: t.timeoutMs ?? defaultTimeoutMs,
      after: [...(t.after || [])],
      ...(isCompute && { compute: t.compute }),
      ...whenBlock,
      ...forEachBlock,
      ...(!isCompute && !isManifest && t.returns && typeof t.returns === "object" && !Array.isArray(t.returns) && { returns: t.returns }),
      ...(!isCompute && !isManifest && !isIntegrate && Array.isArray(t.mustRead) && { mustRead: t.mustRead }),
      ...(!isCompute && !isManifest && !isIntegrate && t.contextWindow !== undefined && { contextWindow: t.contextWindow }),
      ...(typeof t.verifyCitations === "boolean" && { verifyCitations: t.verifyCitations }),
      ...(taskSettings && typeof taskSettings === "object" && !Array.isArray(taskSettings) && { settings: taskSettings }),
      ...(childPlans?.has(t.id) && { childPlan: childPlans.get(t.id) }),
      ...(guard && { leafGuard: guard }),
    };
  });
}
