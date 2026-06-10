import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadPipelineConfig } from "../pipeline-config.mjs";
import { connectUnified, close, dbPathUnified } from "../../scripts/pipeline-db/connection.mjs";
import { projectList } from "../../scripts/pipeline-db/projects.mjs";
import { readState, pidAlive } from "../../scripts/orchestrator/state-file.mjs";
import { findClaudeSlackPlugin } from "../locators/claude-slack.mjs";
import { resolveTemplate, resolveHookFirstToken, PLACEHOLDER_KEYS } from "../../scripts/worktree-paths.mjs";

const execFileAsync = promisify(execFile);

// Surface every config-driven path key, resolved against the §B category for
// its key. Used by the `path-resolution-consistency` doctor check. `existsExpected`
// flags whether a non-existent resolved path is a warn-worthy state.
function _pathResolutionChecks(cfg, projects, paths) {
  const out = [];
  const cd = paths.configDir;
  const _global = (raw) => raw
    ? resolveTemplate(raw, {}, { resolveBase: cd, configDir: cd })
    : null;
  // Global / install-wide keys.
  out.push({ key: "notifications.fallback_dir",  raw: cfg.notifications?.fallback_dir,  resolved: _global(cfg.notifications?.fallback_dir) ?? join(paths.stateDir, "notifications"), warn: false });
  out.push({ key: "session_templates_dir",       raw: cfg.session_templates_dir,        resolved: _global(cfg.session_templates_dir) ?? "(bundled)", warn: cfg.session_templates_dir ? !existsSync(_global(cfg.session_templates_dir)) : false });
  out.push({ key: "hooks.on_notification",       raw: cfg.hooks?.on_notification,       resolved: resolveHookFirstToken(cfg.hooks?.on_notification, cd) ?? "(unset)", warn: false });
  out.push({ key: "hooks.on_merge_ready",        raw: cfg.hooks?.on_merge_ready,        resolved: resolveHookFirstToken(cfg.hooks?.on_merge_ready,  cd) ?? "(unset)", warn: false });
  // hooks.on_merge consumer (skills/merge/scripts/merge.mjs) doesn't yet route through
  // resolveTemplate — operators must use an absolute path until the retrofit lands.
  // We surface the raw value verbatim so doctor doesn't lie about what the runtime sees.
  out.push({ key: "hooks.on_merge (raw — bypasses resolveTemplate)", raw: cfg.hooks?.on_merge, resolved: cfg.hooks?.on_merge ?? "(unset)", warn: false });
  out.push({ key: "governor.template_path",      raw: cfg.governor?.template_path,      resolved: _global(cfg.governor?.template_path) ?? "(bundled)", warn: cfg.governor?.template_path ? !existsSync(_global(cfg.governor.template_path)) : false });

  // Per-project keys. Resolved against each registered project's root_path.
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
