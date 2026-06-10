import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, delimiter as pathDelimiter } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  rowGet, rowUpdate, setLastError,
  sessionRecordSpawn,
  appendSpawn,
} from "../pipeline-db/index.mjs";
import { loadPipelineConfig } from "../../src/pipeline-config.mjs";
import { featureWorktreePath } from "../worktree-paths.mjs";
import { publishNotification } from "../publisher.mjs";
import { detectDefaultBranch } from "../../src/cli/helpers.mjs";

// ── session type routing ──────────────────────────────────────────────────────

export const TOOLS = {
  dev:      "Bash,Read,Write,Edit,Glob,Grep",
  research: "Bash,Read,Write,Glob,Grep,WebFetch,WebSearch",
  review:   "Bash,Read,Glob,Grep",
  test:     "Bash,Read,Write,Glob,Grep",
};

const STAGE = {
  dev:      "dev",
  research: "research",
  review:   "review",
  test:     "test",
};

export function sessionTypeFromNotes(notes) {
  const m = String(notes).match(/\btype=(dev|research|test|review)\b/);
  return m ? m[1] : "dev";
}

export function modelFromNotes(notes, project, feature, stype, logFn, row) {
  const m = String(notes).match(/\bmodel=([\w.:-]+)\b/);
  if (m) return m[1];
  // Fall back to the row's typed model columns (set via --d-model / --rvw-model at queue time)
  if (row) {
    const col = stype === "review" ? row.rvw_model : row.d_model;
    if (col && col !== "—") return col;
  }
  const cfg = loadPipelineConfig();
  const defaultModel = stype === "review"
    ? cfg.models.review_default
    : cfg.models.dev_default;
  if (logFn) logFn(`[${project}] row '${feature}' has no model= pin — defaulting to ${defaultModel}`, "WARN");
  return defaultModel;
}

export function budgetFromNotes(notes) {
  const m = String(notes).match(/\bbudget=([\d.]+)\b/);
  return m ? m[1] : "10.00";
}

// ── worktree helpers ──────────────────────────────────────────────────────────

export function ensureWorktree(projectDir, wtPath, branch, baseBranch, logFn) {
  if (existsSync(wtPath)) {
    logFn(`Reusing worktree at ${wtPath} for branch ${branch}`);
    return true;
  }
  mkdirSync(join(wtPath, ".."), { recursive: true });
  spawnSync("git", ["-C", projectDir, "fetch", "--quiet"], { timeout: 30000, windowsHide: true });
  const r = spawnSync(
    "git", ["-C", projectDir, "worktree", "add", "-b", branch, wtPath, baseBranch],
    { timeout: 60000, windowsHide: true, encoding: "utf8" }
  );
  if (r.status === 0) {
    logFn(`Created worktree at ${wtPath} for branch ${branch}`);
    return true;
  }
  if (r.stderr && r.stderr.includes("already exists")) {
    const r2 = spawnSync(
      "git", ["-C", projectDir, "worktree", "add", wtPath, branch],
      { timeout: 60000, windowsHide: true, encoding: "utf8" }
    );
    if (r2.status === 0) {
      logFn(`Created worktree at ${wtPath} (existing branch ${branch})`);
      return true;
    }
    logFn(`git worktree add failed (attach): ${(r2.stderr || "").trim()}`, "ERROR");
  } else {
    logFn(`git worktree add failed: ${(r.stderr || "").trim()}`, "ERROR");
  }
  return false;
}

export function gitWorktreeClean(wtPath, logFn) {
  if (!existsSync(wtPath)) return true;
  for (const extraArgs of [[], ["--cached"]]) {
    try {
      const r = spawnSync(
        "git", ["-C", wtPath, "diff", "--exit-code", ...extraArgs],
        { timeout: 30000, windowsHide: true, stdio: "ignore" }
      );
      if (r.status !== 0) return false;
    } catch (e) {
      if (logFn) logFn(`git worktree clean check failed for ${wtPath}: ${e.message}`, "ERROR");
      return false;
    }
  }
  return true;
}

export function validateSessionSlug(sessionFile, planStem) {
  if (!planStem || !sessionFile) return null;
  const parts = basename(String(sessionFile), ".md").split("-");
  if (parts.length < 5 || !["dev", "test", "research", "review"].includes(parts[0])) return null;
  const sessionSlug = parts.slice(4).join("-");
  if (sessionSlug === planStem) return null;
  return (
    `session file slug '${sessionSlug}' does not match plan stem '${planStem}' — ` +
    `orchestrator would create worktree on autonomous/${planStem} but session expects autonomous/${sessionSlug}`
  );
}

export function findClaude() {
  // Return the RESOLVED absolute path so spawn() skips PATH lookup. Returning
  // the literal "claude" lets spawnSession's env.PATH (which prepends
  // ~/.local/bin) override the demo's shim, causing real Claude to run in
  // demo mode and burn tokens. Take the first line of `where`'s output —
  // that's the highest-priority match given the caller's PATH at lookup time.
  const localBin = join(homedir(), ".local", "bin");
  for (const candidate of ["claude", join(localBin, "claude.exe"), join(localBin, "claude")]) {
    const r = spawnSync("where", [candidate], { timeout: 3000, windowsHide: true, encoding: "utf8" });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      const resolved = r.stdout.split(/\r?\n/)[0].trim();
      return resolved || candidate;
    }
  }
  return "claude";
}

// Non-Claude models route through the local proxy (claude-code-proxy on :18081).
// Returns env-var overrides to merge; empty for native Claude models.
export function proxyEnvFor(model) {
  if (!model || model.startsWith("claude-")) return {};
  return {
    ANTHROPIC_BASE_URL: "http://localhost:18081",
    ANTHROPIC_API_KEY:  "dummy-local-key",
    ANTHROPIC_MODEL:    model,
  };
}

// ── session spawner ───────────────────────────────────────────────────────────

// Spawn a Claude session for one queued pipeline row. Takes the unified DB,
// project name, registered project root, and pipeline row.
export function spawnSession(project, row, sessionFile, projectRoot, { db, dryRun, logFn }) {
  const feature  = row.feature;
  const notes    = row.notes_extra || "";
  const stype    = sessionTypeFromNotes(notes);
  const model    = modelFromNotes(notes, project, feature, stype, logFn, row);
  const budget   = budgetFromNotes(notes);
  const newStage = STAGE[stype] || "dev";
  const tools    = TOOLS[stype] || TOOLS.dev;

  if (dryRun) {
    logFn(`[${project}] DRY-RUN: would spawn ${stype} session for '${feature}'`);
    logFn(`  session file: ${sessionFile}`);
    return null;
  }

  // 0. Pre-flight: plan file must exist on disk. queue-plan validates this at
  // intake, but the file can move/delete between queue-time and spawn-time
  // (e.g. plan promoted to plans/complete/). Without this guard, session-gen
  // silently substitutes empty PLAN_CONTENT, the agent has nothing to do and
  // exits 0 without handoff, and the reaper parks at manual — burning a full
  // claude -p session producing nothing. Detect up front, park with a clear
  // reason, never launch.
  const planPathForCheck = (row.plan_file || "").trim();
  if (!planPathForCheck || !existsSync(planPathForCheck)) {
    const ts = new Date().toISOString().slice(0, 16);
    const reason = planPathForCheck ? "plan-file-missing" : "plan-file-empty";
    const note   = `[${reason} ${ts}]`;
    logFn(`[${project}] '${feature}' ${reason}: ${planPathForCheck || "(empty)"} — parking at manual`, "ERROR");
    try {
      const r = rowGet(db, project, feature);
      const existing = r ? (r.notes_extra || "") : "";
      rowUpdate(db, project, feature, {
        stage:       "manual",
        notes_extra: existing ? `${existing} ${note}` : note,
      });
    } catch {}
    publishNotification({
      title: `Spawn Blocked: ${feature} (${reason})`,
      message: (
        `${stype} session for '${feature}' in ${project} blocked before spawn.\n` +
        `Reason: ${reason} — plan_file '${planPathForCheck || "(empty)"}' not found on disk.\n` +
        `Operator: restore the plan file or row-delete the row.`
      ),
      priority: "high",
    }).catch(() => {});
    return null;
  }

  // 1. Advance stage queued → <stage>
  try {
    const ok = rowUpdate(db, project, feature, { stage: newStage });
    if (!ok) {
      setLastError(db, project, feature, "stage-advance failed before spawn");
      logFn(`[${project}] WARNING: could not update pipeline row for '${feature}'`, "WARN");
      return null;
    }
  } catch (e) {
    logFn(`[${project}] WARNING: stage-advance threw for '${feature}': ${e.message}`, "WARN");
    return null;
  }

  // 2. Determine working directory.
  const planStem       = basename(row.plan_file || "", ".md") || "";
  const pipelineBranch = (row.branch || "—").trim();
  let cwd = null;

  // Bootstrap absent project root for worktree-eligible sessions
  if (!existsSync(projectRoot) && planStem && ["dev", "test", "review"].includes(stype)) {
    try {
      mkdirSync(projectRoot, { recursive: true });
      const defaultBranch = detectDefaultBranch(projectRoot) || "main";
      spawnSync("git", ["init", "-q", "-b", defaultBranch], { cwd: projectRoot, windowsHide: true });
      writeFileSync(join(projectRoot, "README.md"), `# ${project}\n\nAutonomous-managed project (orchestrator bootstrap).\n`, "utf8");
      spawnSync("git", ["-C", projectRoot, "add", "README.md"], { windowsHide: true });
      spawnSync("git", ["-C", projectRoot, "-c", "commit.gpgsign=false", "commit", "-m", "Initial commit (orchestrator bootstrap)"], {
        cwd: projectRoot, windowsHide: true,
        env: { ...process.env, GIT_AUTHOR_NAME: "Claude Agent", GIT_AUTHOR_EMAIL: "claude-agent@orchestrator", GIT_COMMITTER_NAME: "Claude Agent", GIT_COMMITTER_EMAIL: "claude-agent@orchestrator" },
      });
      logFn(`[${project}] bootstrap_project — created git repo at ${projectRoot}`, "WARN");
    } catch (e) {
      logFn(`[${project}] project bootstrap failed: ${e.message}`, "ERROR");
    }
  }

  if (existsSync(projectRoot)) {
    if (planStem && ["dev", "test", "review"].includes(stype)) {
      const branch = (pipelineBranch && pipelineBranch !== "—")
        ? pipelineBranch
        : `autonomous/${planStem}`;

      const slugErr = validateSessionSlug(sessionFile, planStem);
      if (slugErr) {
        logFn(`[${project}] session slug mismatch — blocking spawn: ${slugErr}`, "ERROR");
        try {
          const row2 = rowGet(db, project, feature);
          const existing = row2 ? (row2.notes_extra || "") : "";
          rowUpdate(db, project, feature, {
            stage:       "manual",
            notes_extra: existing ? `${existing} blocked: ${slugErr}` : `blocked: ${slugErr}`,
          });
        } catch {}
        return null;
      }

      const wtPath = featureWorktreePath({ project, projectRoot, feature: planStem });
      const targetBranch = row.target_branch || detectDefaultBranch(projectRoot);
      if (ensureWorktree(projectRoot, wtPath, branch, targetBranch, logFn)) {
        cwd = wtPath;
      } else {
        logFn(`[${project}] worktree unavailable — falling back to project dir`, "WARN");
        cwd = projectRoot;
      }
    } else {
      cwd = projectRoot;
    }
  }

  // 3. Correlation ID: feature-YYYYMMDDTHHMMSSz
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const correlationId = `${feature}-${ts}`;

  const worktreeCreated = !!(cwd && cwd !== projectRoot);
  const spawnReason = worktreeCreated
    ? "worktree created"
    : (!planStem || stype === "research" ? "no plan/research session" : "worktree creation failed");

  logFn(`[${project}] spawning ${stype} session for '${feature}' (corr_id=${correlationId})`);
  logFn(`  session file: ${sessionFile}`);
  logFn(`  cwd: ${cwd}`);
  logFn(`  reason: ${spawnReason}`);

  const claudePath = findClaude();
  const prompt = `export CORRELATION_ID='${correlationId}'; Read '${sessionFile}' in full and execute the session.`;
  const args = [
    "-p", prompt,
    "--model", model,
    "--allowedTools", tools,
    "--max-budget-usd", budget,
  ];

  const env = { ...process.env };
  env.GIT_AUTHOR_NAME  = "Claude Agent";
  env.GIT_AUTHOR_EMAIL = `claude-agent@${correlationId}`;
  env.CORRELATION_ID   = correlationId;
  const localBin = join(homedir(), ".local", "bin");
  env.PATH = [localBin, env.PATH || ""].filter(Boolean).join(pathDelimiter);

  const proxyEnv = proxyEnvFor(model);
  if (Object.keys(proxyEnv).length) {
    Object.assign(env, proxyEnv);
    logFn(`[${project}] proxy model detected — routing '${model}' via local proxy`);
  }

  // Windows: Node's spawn() rejects .bat/.cmd directly with EINVAL, and
  // wrapping via shell:true makes cmd.exe re-parse the args — which mangles
  // any prompt containing quotes/semicolons. Real claude is claude.exe so
  // this is moot in production. For demo .bat shims (which are thin
  // `node "<script>" %*` wrappers), peel off the .bat layer and invoke
  // node directly with the underlying script — no shell, no arg corruption.
  let spawnCmd = claudePath;
  let spawnArgs = args;
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(claudePath)) {
    try {
      const shimContent = readFileSync(claudePath, "utf8");
      const m = shimContent.match(/node(?:\.exe)?\s+"([^"]+)"\s+%\*/i);
      if (m && m[1]) {
        spawnCmd = process.execPath;
        spawnArgs = [m[1], ...args];
        logFn(`[${project}] demo shim detected — invoking node directly: ${m[1]}`);
      } else {
        logFn(`[${project}] WARN: ${claudePath} looks like a .bat shim but doesn't match the expected 'node "..." %*' pattern — spawn will likely fail`, "WARN");
      }
    } catch (e) {
      logFn(`[${project}] WARN: could not read shim ${claudePath}: ${e.message}`, "WARN");
    }
  }
  const proc = spawn(spawnCmd, spawnArgs, {
    cwd:         cwd || undefined,
    env,
    windowsHide: true,
    detached:    true,
    stdio:       "ignore",
  });
  process.stderr.write(JSON.stringify({
    event:          "session_spawn",
    correlation_id: correlationId,
    pid:            proc.pid,
    cwd:            cwd || "",
    session_type:   stype,
    session_file:   String(sessionFile),
  }) + "\n");
  proc.unref();
  proc._feature       = feature;
  proc._correlationId = correlationId;
  proc._stype         = stype;
  proc._project       = project;
  proc._projectRoot   = projectRoot;
  proc._startTime     = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  logFn(`[${project}] spawned ${stype} session for '${feature}' (pid ${proc.pid}, corr_id=${correlationId})`);

  // Record spawn in unified DB (sessions table)
  try {
    sessionRecordSpawn(db, {
      correlationId, project, feature,
      sessionType: stype,
      cwd:         cwd || "",
      sessionFile: String(sessionFile),
      pid:         proc.pid,
    });
  } catch (e) {
    logFn(`[${project}] warning: failed to record session in DB: ${e.message}`, "WARN");
  }

  // Record spawn in global analytics (session_spawn_map)
  try {
    appendSpawn(db, {
      spawn_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      corr_id:    correlationId,
      stype,
      cwd:        cwd || "",
      project,
      feature,
    });
  } catch (e) {
    logFn(`[${project}] warning: failed to write session spawn map: ${e.message}`, "WARN");
  }

  return proc;
}

// ── merge spawner ─────────────────────────────────────────────────────────────

export function isDirtyTree(projectRoot) {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], {
      cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
    if (r.status !== 0) return true;  // git failed → can't verify clean → assume dirty
    return r.stdout.trim().length > 0;
  } catch { return true; }
}

export function isMergedInto(targetBranch, featureBranch, projectRoot) {
  try {
    const r = spawnSync("git", ["merge-base", "--is-ancestor", targetBranch, featureBranch], {
      cwd: projectRoot, stdio: "ignore", encoding: "utf8",
    });
    return r.status === 0;
  } catch { return false; }
}

export function spawnMerge(project, row, projectRoot, model, { db, dryRun, logFn }) {
  const feature      = row.feature;
  const branch       = row.branch || `autonomous/${feature}`;
  const targetBranch = row.target_branch || detectDefaultBranch(projectRoot);

  if (dryRun) {
    logFn(`[${project}] DRY-RUN: would spawn merge agent for '${feature}' model=${model}`);
    return null;
  }

  const cfg        = loadPipelineConfig();
  const pluginRoot = fileURLToPath(new URL("../../..", import.meta.url)); // scripts/orchestrator → plugin root
  const plansDir   = cfg.plansDir
    ? cfg.plansDir.replace(/\{project\}/g, project)
    : null;
  const resolvedPlansDir = plansDir
    ? (plansDir.startsWith("/") || /^[A-Za-z]:[/\\]/.test(plansDir)
        ? plansDir
        : join(projectRoot, "..", plansDir))
    : null;

  const plansDirFlag = resolvedPlansDir ? `--plans-dir "${resolvedPlansDir}"` : "";
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const correlationId = `merge-${feature}-${ts}`;
  const sessionSlug   = `merge_${feature}`;

  const mergeScript = fileURLToPath(new URL("../../skills/merge/scripts/merge.mjs", import.meta.url));
  const prompt = [
    `Run the merge for ${branch}.`,
    `plugin-root: ${pluginRoot}. project-dir: ${projectRoot}.`,
    `branches: ${branch}`,
    `target-branch: ${targetBranch}`,
    ``,
    `Steps:`,
    `1. Working tree may be dirty — stash with git stash --include-untracked if needed; pop after.`,
    `2. git checkout ${targetBranch}`,
    `3. Run: node "${mergeScript}" --branches ${branch} --project-dir "${projectRoot}" --session-slug ${sessionSlug} --target-branch ${targetBranch} ${plansDirFlag}`,
    `4. If exit non-zero, report BLOCKER lines from stderr.`,
    `5. If exit zero, report: branch merged, plan location, squash commit hash.`,
    `6. Pop stash if created.`,
    `Do NOT ask for confirmation. Proceed or emit BLOCKER and exit.`,
  ].join("\n");

  logFn(`[${project}] spawning merge agent for '${feature}' model=${model} (corr_id=${correlationId})`);

  const claudePath = findClaude();
  const args = [
    "-p", prompt,
    "--model", model,
    "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
    "--max-budget-usd", "3.00",
  ];

  const env = { ...process.env, CORRELATION_ID: correlationId };
  const localBin = join(homedir(), ".local", "bin");
  env.PATH = [localBin, env.PATH || ""].filter(Boolean).join(pathDelimiter);

  {
    const proxyEnv = proxyEnvFor(model);
    if (Object.keys(proxyEnv).length) {
      Object.assign(env, proxyEnv);
      logFn(`[${project}] proxy model detected — routing '${model}' via local proxy (merge)`);
    }
  }

  // Windows: handle .bat/.cmd shims
  let spawnCmd = claudePath;
  let spawnArgs = args;
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(claudePath)) {
    try {
      const shimContent = readFileSync(claudePath, "utf8");
      const m = shimContent.match(/node(?:\.exe)?\s+"([^"]+)"\s+%\*/i);
      if (m && m[1]) {
        spawnCmd = process.execPath;
        spawnArgs = [m[1], ...args];
        logFn(`[${project}] demo shim detected — invoking node directly: ${m[1]}`);
      }
    } catch (e) {
      logFn(`[${project}] WARN: could not read shim ${claudePath}: ${e.message}`, "WARN");
    }
  }

  const proc = spawn(spawnCmd, spawnArgs, {
    cwd: projectRoot, env, windowsHide: true, detached: true, stdio: "ignore",
  });
  proc.unref();
  proc._feature       = feature;
  proc._correlationId = correlationId;
  proc._stype         = "merge";
  proc._project       = project;
  proc._projectRoot   = projectRoot;
  proc._startTime     = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return proc;
}
