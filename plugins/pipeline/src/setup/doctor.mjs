import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadPipelineConfig } from "../pipeline-config.mjs";
import { connectUnified, close, dbPathUnified } from "../../scripts/pipeline-db/connection.mjs";
import { projectList } from "../../scripts/pipeline-db/projects.mjs";
import { readState, pidAlive } from "../../scripts/orchestrator/state-file.mjs";
import { findClaudeSlackPlugin } from "../locators/claude-slack.mjs";
import { resolveTemplate, resolveHookFirstToken, featureWorktreePath } from "../../scripts/worktree-paths.mjs";
import { spawnSync } from "node:child_process";

const execFileAsync = promisify(execFile);

function _pathResolutionChecks(cfg, projects, paths) {
  const out = [];
  const cd = paths.configDir;
  const _global = (raw) => raw
    ? resolveTemplate(raw, {}, { resolveBase: cd, configDir: cd })
    : null;
  out.push({ key: "notifications.fallback_dir",  raw: cfg.notifications?.fallback_dir,  resolved: _global(cfg.notifications?.fallback_dir) ?? join(paths.stateDir, "notifications"), warn: false });
  out.push({ key: "session_templates_dir",       raw: cfg.session_templates_dir,        resolved: _global(cfg.session_templates_dir) ?? "(bundled)", warn: cfg.session_templates_dir ? !existsSync(_global(cfg.session_templates_dir)) : false });
  out.push({ key: "hooks.on_notification",       raw: cfg.hooks?.on_notification,       resolved: resolveHookFirstToken(cfg.hooks?.on_notification, cd) ?? "(unset)", warn: false });
  out.push({ key: "hooks.on_merge_ready",        raw: cfg.hooks?.on_merge_ready,        resolved: resolveHookFirstToken(cfg.hooks?.on_merge_ready,  cd) ?? "(unset)", warn: false });
  // on_merge consumer (skills/merge/scripts/merge.mjs) doesn't route through resolveTemplate yet.
  out.push({ key: "hooks.on_merge (raw — bypasses resolveTemplate)", raw: cfg.hooks?.on_merge, resolved: cfg.hooks?.on_merge ?? "(unset)", warn: false });
  out.push({ key: "governor.template_path",      raw: cfg.governor?.template_path,      resolved: _global(cfg.governor?.template_path) ?? "(bundled)", warn: cfg.governor?.template_path ? !existsSync(_global(cfg.governor.template_path)) : false });

  for (const p of projects ?? []) {
    const _proj = (raw) => raw
      ? resolveTemplate(raw, { root: p.root_path, project: p.name }, { resolveBase: p.root_path, configDir: cd })
      : null;
    out.push({ key: `[${p.name}] plansDir`,             raw: cfg.plansDir,             resolved: _proj(cfg.plansDir) ?? join(p.root_path, "plans"), warn: false });
    out.push({ key: `[${p.name}] governor.reports_dir`, raw: cfg.governor?.reports_dir, resolved: _proj(cfg.governor?.reports_dir) ?? join(p.root_path, "reports"), warn: false });
    out.push({ key: `[${p.name}] governor.session_dir`, raw: cfg.governor?.session_dir, resolved: _proj(cfg.governor?.session_dir) ?? join(p.root_path, "sessions"), warn: false });
    out.push({ key: `[${p.name}] governor.log_dir`,     raw: cfg.governor?.log_dir,     resolved: _proj(cfg.governor?.log_dir)     ?? join(p.root_path, "logs"), warn: false });
  }
  return out;
}

// Run the doctor checks and return a results array. Each result:
//   { label, ok: boolean, warn: boolean, detail: string }
// `ok=true, warn=false` → ✓; `ok=false, warn=true` → ⚠; `ok=false, warn=false` → ✗.
//
// Injection seams for testability:
//   paths       — required: { stateDir, dataDir, ... } shape from src/paths.mjs
//   configPath  — override ~/.pipeline/config.json
//   timeout     — claude CLI probe timeout (default 5000ms)
//   db          — pre-opened unified DB handle (otherwise opened internally)
export async function runDoctor({ paths, configPath, timeout = 5000, db: injectedDb } = {}) {
  if (!paths) throw new Error("runDoctor: paths is required");
  const cfgPath = configPath || join(homedir(), ".pipeline", "config.json");

  const results = [];
  const push = (label, ok, warn, detail) => results.push({ label, ok, warn, detail });

  // 1. Node.js ≥ 22
  const nodeVersion = process.versions.node;
  const nodeMajor   = parseInt(nodeVersion.split(".")[0], 10);
  push(
    "Node.js ≥ 22",
    nodeMajor >= 22, false,
    nodeMajor >= 22 ? `v${nodeVersion}` : `v${nodeVersion} (need ≥22)`
  );

  // 2. claude CLI
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout });
    push("claude CLI", true, false, stdout.trim() || "ok");
  } catch (e) {
    push("claude CLI", false, false, e.message || "not found");
  }

  // 3. pipeline state dir
  try {
    mkdirSync(paths.stateDir, { recursive: true });
    push("pipeline state dir", true, false, paths.stateDir);
  } catch (e) {
    push("pipeline state dir", false, false, e.message || paths.stateDir);
  }

  // 4. pipeline data dir
  try {
    mkdirSync(paths.dataDir, { recursive: true });
    push("pipeline data dir", true, false, paths.dataDir);
  } catch (e) {
    push("pipeline data dir", false, false, e.message || paths.dataDir);
  }

  // 5. pipeline DB readable (warn if absent — legit fresh install)
  const dbFile = dbPathUnified(paths);
  let db = injectedDb || null;
  let weOpenedDb = false;
  if (!existsSync(dbFile) && !db) {
    push("pipeline DB readable", false, true, `${dbFile} (absent — fresh install)`);
  } else {
    try {
      if (!db) {
        db = connectUnified(paths);
        weOpenedDb = true;
      }
      db.prepare("SELECT 1").get();
      push("pipeline DB readable", true, false, dbFile);
    } catch (e) {
      push("pipeline DB readable", false, false, `${dbFile} (${e.message || "open failed"})`);
      db = null;
    }
  }

  // 6. config.json parseable (warn if absent — defaults apply)
  if (!existsSync(cfgPath)) {
    push("config.json parseable", false, true, `${cfgPath} (absent — defaults apply)`);
  } else {
    try {
      JSON.parse(readFileSync(cfgPath, "utf8"));
      push("config.json parseable", true, false, cfgPath);
    } catch (e) {
      push("config.json parseable", false, false, `${cfgPath} (malformed: ${e.message})`);
    }
  }

  // The remaining notification checks use the resolved config (with defaults
  // filled in) so they reflect what the runtime would actually see.
  const resolved          = loadPipelineConfig(cfgPath);
  // Backward-compat: pre-rename key was `slack_channel`. Prefer new
  // `governance_channel`; fall back to legacy key for existing configs.
  const governanceChannel = resolved.notifications?.governance_channel
                         ?? resolved.notifications?.slack_channel
                         ?? null;
  const pipelineChannel   = resolved.notifications?.pipeline_channel ?? null;
  const effectivePipelineChannel = pipelineChannel || governanceChannel;
  const onNotification    = resolved.hooks?.on_notification ?? resolved.notifications?.on_write ?? null;

  // 7a. Governance / general channel (warn if null — common and intentional)
  if (governanceChannel) {
    push("Governance channel set", true, false, governanceChannel);
  } else {
    push("Governance channel set", false, true, "null — reports / general notifications disabled");
  }
  // 7b. Pipeline-events channel (separate from governance)
  if (pipelineChannel) {
    push("Pipeline channel set", true, false, `${pipelineChannel} (separate from governance)`);
  } else if (governanceChannel) {
    push("Pipeline channel set", false, true, `null — pipeline events fall back to '${governanceChannel}'`);
  } else {
    push("Pipeline channel set", false, true, "null — pipeline events disabled");
  }
  // 7c. on_notification hook (the actual forwarder) — must be set for any Slack post to happen
  if (onNotification) {
    if (existsSync(onNotification)) {
      push("hooks.on_notification", true, false, onNotification);
    } else {
      push("hooks.on_notification", false, true, `set but file missing: ${onNotification}`);
    }
  } else if (effectivePipelineChannel || governanceChannel) {
    push("hooks.on_notification", false, true,
      "unset — pipeline writes envelope JSON only; nothing forwards to Slack. Re-run setup to wire claude-slack.");
  } else {
    push("hooks.on_notification", false, true, "unset — no channels configured (skipping)");
  }

  // 8. claude-slack plugin — uses the shared locator (env > cache > PATH).
  // The env-var contract is "use this specifically" — if it's set but missing,
  // we warn rather than silently fall back to cache.
  if (!governanceChannel) {
    push("claude-slack-plugin", false, true, "skipped — no Slack channel configured");
  } else if (process.env.CLAUDE_SLACK_PLUGIN && !existsSync(process.env.CLAUDE_SLACK_PLUGIN)) {
    push("claude-slack-plugin", false, true, `CLAUDE_SLACK_PLUGIN=${process.env.CLAUDE_SLACK_PLUGIN} (file missing)`);
  } else {
    const found = findClaudeSlackPlugin();
    if (found.path) {
      push("claude-slack-plugin", true, false, `${found.path} (source=${found.source})`);
    } else {
      push("claude-slack-plugin", false, true, "not found — Slack notifications will silently no-op");
    }
  }

  // 8b. pipeline-home — resolved configDir for this platform. Informational;
  // warn (not fail) if the implicit default doesn't exist (fresh install).
  {
    const home = paths.configDir;
    if (existsSync(home)) {
      push("pipeline-home", true, false, home);
    } else {
      push("pipeline-home", false, true, `${home} (absent — likely fresh install)`);
    }
  }

  // 9. orchestrator not already running (warn if running — informational)
  const state = readState();
  if (state?.status === "running" && state.pid && pidAlive(state.pid)) {
    push("orchestrator not running", false, true, `already running (PID ${state.pid}, since ${state.started_at || "?"})`);
  } else {
    push("orchestrator not running", true, false, state ? "stale state file" : "no state file");
  }

  // 10. at least one project registered (warn if zero — orchestrator would idle)
  let projects = [];
  if (db) {
    try {
      projects = projectList(db) || [];
    } catch {
      projects = [];
    }
  }
  if (projects.length > 0) {
    push("at least one project", true, false, `${projects.length} registered`);
  } else {
    push("at least one project", false, true, "0 registered — `pipeline project-add <name> <path>`");
  }

  // 11. registered project paths exist (fail if any missing)
  if (projects.length === 0) {
    push("registered project paths", true, false, "(no projects to check)");
  } else {
    const missing = [];
    for (const p of projects) {
      if (!existsSync(p.root_path)) {
        missing.push(`${p.name} → ${p.root_path} (not found)`);
      } else if (!existsSync(join(p.root_path, ".git"))) {
        missing.push(`${p.name} → ${p.root_path} (not a git repo)`);
      }
    }
    if (missing.length === 0) {
      push("registered project paths", true, false, `${projects.length} verified`);
    } else {
      push("registered project paths", false, false, missing.join("; "));
    }
  }

  // 12. path-resolution-consistency — for every config-driven path key,
  // print raw config value + resolved path. Warn when a key resolves to a
  // non-existent file/dir where existence is expected. Runs after `projects`
  // is populated so per-project keys can be exercised against each registry row.
  {
    const checks = _pathResolutionChecks(resolved, projects, paths);
    const failed = checks.filter(c => c.warn);
    const detail = checks.map(c =>
      `${c.key}=${c.raw == null ? "(default)" : JSON.stringify(c.raw)} → ${c.resolved}${c.warn ? " ⚠ missing" : ""}`
    ).join("; ");
    push(
      "path-resolution-consistency",
      failed.length === 0, failed.length > 0,
      detail || "(no keys to check)"
    );
  }

  // 13. worktree-layout-stale — phase 3b warns when on-disk worktrees don't
  // match the resolved feature template, so the operator knows to clean up.
  if (projects.length === 0) {
    push("worktree-layout-stale", true, false, "(no projects to check)");
  } else {
    const stale = [];
    for (const p of projects) {
      if (!existsSync(join(p.root_path, ".git"))) continue;
      let listed;
      try {
        const r = spawnSync("git", ["-C", p.root_path, "worktree", "list", "--porcelain"],
          { encoding: "utf8", windowsHide: true, timeout: 5000 });
        if (r.status !== 0) continue;
        listed = r.stdout;
      } catch { continue; }
      const paths = [];
      for (const line of listed.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
      }
      for (const wtPath of paths) {
        if (!wtPath || wtPath === p.root_path) continue;
        // Use the basename as a candidate feature to compute the canonical path.
        const feature = wtPath.split(/[\\/]/).filter(Boolean).pop();
        const expected = featureWorktreePath({
          project: p.name, projectRoot: p.root_path, feature, _config: resolved,
        });
        const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/$/, "");
        if (norm(wtPath) !== norm(expected)) {
          stale.push(`${p.name}: ${wtPath} (run \`git -C "${p.root_path}" worktree remove "${wtPath}"\`)`);
        }
      }
    }
    if (stale.length === 0) {
      push("worktree-layout-stale", true, false, "no stale worktrees");
    } else {
      push("worktree-layout-stale", false, true, stale.join("; "));
    }
  }

  // 14. web-port-conflict — warn if a process is bound on the configured
  // web.port and it does NOT look like our own dashboard server.
  {
    const cfgPort = resolved?.web?.port ?? 8765;
    let portInUse = false;
    let portOurServer = false;
    try {
      const r = spawnSync(
        process.platform === "win32"
          ? "cmd"
          : "bash",
        process.platform === "win32"
          ? ["/c", `netstat -ano -p TCP 2>nul | findstr ":${cfgPort} "`]
          : ["-c", `ss -tlnp 2>/dev/null | grep ':${cfgPort} ' || lsof -iTCP:${cfgPort} -sTCP:LISTEN -n -P 2>/dev/null | head -2`],
        { encoding: "utf8", windowsHide: true, timeout: 3000 }
      );
      if (r.stdout && r.stdout.includes(String(cfgPort))) {
        portInUse = true;
        // Heuristic: if the dashboard is running, its process title contains "pipeline"
        // or the parent process is node running pipeline.mjs.  We can't be definitive
        // here so this is a warn-only check.
        portOurServer = /pipeline/i.test(r.stdout);
      }
    } catch { /* non-fatal */ }

    if (!portInUse) {
      push("web-port-conflict", true, false, `port ${cfgPort} is free`);
    } else if (portOurServer) {
      push("web-port-conflict", true, false, `port ${cfgPort} in use by dashboard (expected)`);
    } else {
      push("web-port-conflict", false, true,
        `port ${cfgPort} (cfg.web.port) appears to be occupied by another process — ` +
        `set a different port in ~/.pipeline/config.json or pass --port to dashboard web`
      );
    }
  }

  // 15. governor-env-contract — when the governor is enabled, confirm the
  // template references only placeholders/vars that the spawn contract provides.
  if (resolved?.governor?.enabled) {
    const contractVars = new Set([
      "CORRELATION_ID", "REPORT_TYPE", "REPORT_DATE", "REPORT_MONTH",
      "PIPELINE_DB", "PLUGIN_DIR",
    ]);
    const templatePath = resolved.governor.template_path
      ? (resolved.governor.template_path.startsWith("~")
          ? join(homedir(), resolved.governor.template_path.slice(1))
          : isAbsolute(resolved.governor.template_path)
              ? resolved.governor.template_path
              : join(homedir(), ".pipeline", resolved.governor.template_path))
      : null;
    // Read whichever template will be used (custom or bundled path from governor.mjs).
    const bundledPath = join(fileURLToPath(new URL("../../templates/governor-session.md", import.meta.url)));
    const tplPath = (templatePath && existsSync(templatePath)) ? templatePath : bundledPath;
    let unknown = [];
    if (existsSync(tplPath)) {
      const tplContent = readFileSync(tplPath, "utf8");
      const varRefs = [...tplContent.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)].map(m => m[1]);
      unknown = [...new Set(varRefs)].filter(v => !contractVars.has(v) && !["PATH", "HOME", "USER", "SHELL"].includes(v));
    }
    if (unknown.length === 0) {
      push("governor-env-contract", true, false, "all template $VAR refs are in spawn contract");
    } else {
      push("governor-env-contract", false, true,
        `template references vars not in spawn contract: ${unknown.join(", ")} — ` +
        "add them to governor.mjs spawn env or remove the references"
      );
    }
  } else {
    push("governor-env-contract", true, false, "governor disabled — skipped");
  }

  if (weOpenedDb && db) {
    try { close(db); } catch {}
  }

  return results;
}

export function printDoctor(results) {
  for (const r of results) {
    const icon = r.ok ? "✓" : r.warn ? "⚠" : "✗";
    process.stdout.write(`${icon} ${r.label}: ${r.detail}\n`);
  }
}

// Exit code policy: any hard failure → 1; warns alone → 0.
export function doctorExitCode(results) {
  return results.some(r => !r.ok && !r.warn) ? 1 : 0;
}
