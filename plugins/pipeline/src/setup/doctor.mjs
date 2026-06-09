import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadPipelineConfig } from "../pipeline-config.mjs";
import { connectUnified, close, dbPathUnified } from "../../scripts/pipeline-db/connection.mjs";
import { projectList } from "../../scripts/pipeline-db/projects.mjs";
import { readState, pidAlive } from "../../scripts/orchestrator/state-file.mjs";

const execFileAsync = promisify(execFile);

// Locate an executable on PATH. Returns the absolute path or null.
function _onPath(name) {
  const pathDirs = (process.env.PATH || "").split(/[;:]/);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".mjs", ".js", ""] : [""];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  // Fallback for claude-slack specifically: walk the plugins-cache the way the
  // bundled forwarder does. The operator's `claude-slack` is a PowerShell
  // function alias from $PROFILE, never on PATH from a non-PowerShell shell —
  // but the binary IS reachable at the known plugin-marketplace install path.
  if (name === "claude-slack") {
    try {
      const home = process.env.USERPROFILE || process.env.HOME || homedir();
      const cache = join(home, ".claude", "plugins", "cache");
      if (existsSync(cache)) {
        for (const owner of readdirSync(cache)) {
          const sb = join(cache, owner, "slack-bridge");
          if (!existsSync(sb)) continue;
          for (const ver of readdirSync(sb)) {
            const exe = join(sb, ver, "bin", "claude-slack.mjs");
            if (existsSync(exe)) return exe;
          }
        }
      }
    } catch {}
  }
  return null;
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

  // 8. claude-slack on PATH (warn — skipped if no channel anyway)
  if (!governanceChannel) {
    push("claude-slack on PATH", false, true, "skipped — no Slack channel configured");
  } else if (process.env.CLAUDE_SLACK_PLUGIN) {
    const env = process.env.CLAUDE_SLACK_PLUGIN;
    if (existsSync(env)) {
      push("claude-slack on PATH", true, false, `CLAUDE_SLACK_PLUGIN=${env}`);
    } else {
      push("claude-slack on PATH", false, true, `CLAUDE_SLACK_PLUGIN=${env} (file missing)`);
    }
  } else {
    const found = _onPath("claude-slack");
    if (found) {
      push("claude-slack on PATH", true, false, found);
    } else {
      push("claude-slack on PATH", false, true, "not found — Slack notifications will silently no-op");
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
