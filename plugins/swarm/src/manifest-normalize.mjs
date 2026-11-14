// ── shared normalization ──────────────────────────────────────────────────────
// Every task, Claude included, passes the governance gate (governance.mjs): it may
// run only under the allow-listed roots, checked against its ORIGINAL effective cwd
// (before any scratch redirect).

import { resolve } from "node:path";
import { CONTEXT_WINDOW_1M } from "./contracts.mjs";
import { declaredEfforts, effortFor } from "./models.mjs";
import { providerConfig } from "./providers.mjs";
import { runScopeKey } from "./worktree.mjs";
import { checkGovernance } from "./governance.mjs";
import { defaultToolsFor, hasWriteTools, resolveWorktreeName } from "./manifest-task-policy.mjs";
import { guardOf, probeGuard, defaultManifestIo, projectFor } from "./manifest-leaf-guard.mjs";
import { leafMcpOff, toolUsesServer } from "./leaf-mcp.mjs";
import { PROVIDERS, checkDenylist, checkHeadroom, resolveProvider, validateEffort } from "./manifest-model-gates.mjs";

export function normalizeTasks(rawTasks, { cwd, resultsDir, cfg, defaultTimeoutMs, errors, label, childPlans, headroom, warnings = [], cache = [], io = defaultManifestIo(), probedGuards = new Set(), providerRegistry = PROVIDERS }) {
  // Many tasks share a cwd; ask git once per directory.
  const tops = new Map();
  const repoTop = (dir) => {
    if (!tops.has(dir)) tops.set(dir, io.checkoutToplevel(dir));
    return tops.get(dir);
  };
  // The MCP roster is one file on this machine; every default-list task reads the
  // same answer, so read it at most once per manifest.
  let mcpRoster;
  const mcpNames = () => (mcpRoster ??= io.mcpTools());
  // A name the config lists that is not a user-scope server and not a plugin server
  // is a typo. Warn once per name: a child manifest shares this array with its parent.
  const knownServers = new Set(mcpNames().map((tool) => tool.replace(/^mcp__/, "")));
  const warnUnknown = (name, key) => {
    if (name.startsWith("plugin:") || knownServers.has(name)) return;
    const message = `${key} names '${name}', which is not a configured MCP server — check \`claude mcp list\``;
    if (!warnings.includes(message)) warnings.push(message);
  };
  for (const name of cfg?.mcp?.off || []) warnUnknown(name, "mcp.off");
  for (const project of cfg?.projects || []) for (const name of project?.mcp?.on || []) warnUnknown(name, "projects[].mcp.on");
  const mcpLines = new Set();
  const reportMcp = (repoName, project, taskId, off, allowedTools) => {
    const machineOff = cfg?.mcp?.off || [];
    if (!machineOff.length) return;
    const key = `${repoName}|${off.join(",")}`;
    if (mcpLines.has(key)) return;
    mcpLines.add(key);
    const turnedOn = machineOff.filter((server) => !off.includes(server));
    const repoOn = turnedOn.filter((server) => (project?.mcp?.on || []).includes(server));
    const tools = String(allowedTools || "").split(",").map((t) => t.trim()).filter(Boolean);
    const taskOn = turnedOn.filter((server) => !repoOn.includes(server) && tools.some((tool) => toolUsesServer(tool, server)));
    const notes = [];
    if (repoOn.length) notes.push(`(${repoName} turns on ${repoOn.join(", ")})`);
    if (taskOn.length) notes.push(`(task ${taskId} names ${taskOn.join(", ")})`);
    io.stdout(`leaf mcp: off ${off.length ? off.join(", ") : "none"}${notes.length ? " " + notes.join(" ") : ""}`);
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
      if (provider) checkGovernance(provider, t.model, originalCwd, l, cfg, errors, io);
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
              checkGovernance(fallbackProvider, t.fallbackModel, originalCwd, `${l} fallback`, cfg, errors, io);
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
    let mcpOff = [];
    if (!isCompute && !isManifest && !isIntegrate) {
      const { project, repoName } = projectFor(originalCwd, cfg, io);
      const resolved = guardOf(project);
      if (t.leafGuard === false) {
        if (resolved) io.stdout(`leaf guard: off (task opt-out)`);
      } else if (resolved) {
        guard = resolved;
        probeGuard(guard, originalCwd, l, io, probedGuards, errors);
        io.stdout(`leaf guard: ${guard.name} → ${guard.command}${provider === "codex" ? " (fires once swarm's hooks are trusted in Codex)" : ""}`);
      }
      mcpOff = leafMcpOff({ project, cfg, allowedTools: t.allowedTools });
      reportMcp(repoName, project, t.id, mcpOff, t.allowedTools);
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
    // An integrate node owns the `into` tree, so it owns that tree's branch — and
    // a bare `swarm/<into>` makes two runs of one manifest seed the SAME branch:
    // the second run lands on the first run's kept tree and dies on a collision.
    // Validation bars `branch` on an integrate task, so the guard only protects a
    // hand-built plan that skipped it.
    if (isIntegrate && !t.branch) branchScope = runScopeKey(resultsDir);
    const worktreeName = isIntegrate ? t.integrate.into : resolveWorktreeName(t);
    const branchName = (isCompute || isManifest) ? undefined : t.branch;
    const whenBlock = t.when && typeof t.when === "object" && !Array.isArray(t.when)
      ? { when: { from: t.when.from, expr: t.when.expr } } : {};
    const forEachBlock = !isCompute && t.forEach && typeof t.forEach === "object" && !Array.isArray(t.forEach)
      ? { forEach: { from: t.forEach.from, path: t.forEach.path ?? "", maxItems: t.forEach.maxItems } } : {};
    const outputDir = t.outputDir ? resolve(cwd, t.outputDir) : undefined;
    // The write guard's roots are NOT computed here. A forEach clone is renamed after
    // normalize, the quota fallback flips `provider` in place, and the generated digest
    // bypasses normalize entirely — so roots frozen at this point would name a tree the
    // leaf never runs in, or a provider that cannot accept them. runTask appends them at
    // spawn instead; each runner adapter translates the same typed list.
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
      // An authored list wins whole. The default is filled in HERE — not appended at
      // dispatch — so the snapshot and the leaf's own result record the list it got.
      allowedTools: isCompute || isManifest || isIntegrate ? "" : t.allowedTools || defaultToolsFor(provider,
        mcpNames().filter((tool) => !mcpOff.some((server) => toolUsesServer(tool, server)))),
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
      ...(t.settings && typeof t.settings === "object" && !Array.isArray(t.settings) && { settings: t.settings }),
      ...(childPlans?.has(t.id) && { childPlan: childPlans.get(t.id) }),
      ...(guard && { leafGuard: guard }),
      // Stamped whatever the primary provider is: a Codex task with a Claude
      // fallback becomes a Claude-CLI leaf at quota time, and only that runner reads it.
      ...(mcpOff.length && { mcpOff }),
    };
  });
}
