// Session scanning: read ~/.claude/history.jsonl + project JSONL files.
// Writes session records to pipeline.db via appendMetricSession.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appendMetricSession, loadMetricSessions, loadSpawnMap, listAllClaudeSessionIds } from "../pipeline-db/index.mjs";
import { estimateTokens } from "./ccusage.mjs";
import { orchestratorWorktreePath } from "../worktree-paths.mjs";

// Pipeline-mechanic entries only — session files the pipeline itself spawns.
const _BUILTIN_FIRST_PROMPT_TYPES = [
  { prefix: "Read sessions/dev-",      type: "dev" },
  { prefix: "Read sessions/research-", type: "research" },
  { prefix: "Read sessions/test-",     type: "test" },
  { prefix: "Read sessions/gov-",      type: "governor" },
];

// Synthetic type — never matched by classifyFirstPrompt, only assigned via fallback.
const _BUILTIN_SYNTHETIC_TYPES = [
  { type: "interactive" },
];

function loadUserClassifications() {
  const cfgPath = join(homedir(), ".pipeline", "config.json");
  if (!existsSync(cfgPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const arr = cfg.session_classifications;
    if (!Array.isArray(arr)) return [];
    return arr.filter(e => typeof e.prefix === "string" && typeof e.type === "string");
  } catch {
    return [];
  }
}

// Maps first-prompt prefix → command type. Order matters; first match wins.
// User config entries prepend (win on prefix collision); built-ins fill the rest.
const _FIRST_PROMPT_TYPES = (() => {
  const user = loadUserClassifications();
  const userPrefixes = new Set(user.map(e => e.prefix));
  return [...user, ..._BUILTIN_FIRST_PROMPT_TYPES.filter(e => !userPrefixes.has(e.prefix))];
})();

const _CORR_ID_RE = /^\s*export\s+CORRELATION_ID='([^']+)'/;
const _SESSION_READ_RE = /^Read '[^']*[/\\]sessions[/\\](dev|research|test|gov)[-]/;

/**
 * Classify session by its first user prompt prefix.
 * Returns [commandType|null, correlationId|null].
 */
export function classifyFirstPrompt(firstPrompt, spawnMap = null) {
  if (!firstPrompt) return [null, null];

  for (const { prefix, type } of _FIRST_PROMPT_TYPES) {
    if (firstPrompt.startsWith(prefix)) return [type, null];
  }

  const mSr = _SESSION_READ_RE.exec(firstPrompt);
  if (mSr) {
    const stype = mSr[1];
    return [stype === "gov" ? "governor" : stype, null];
  }

  const m = _CORR_ID_RE.exec(firstPrompt);
  if (m) {
    const corrId = m[1];
    if (corrId.startsWith("governor-")) return ["governor", corrId];
    if (spawnMap) {
      for (const s of spawnMap) {
        if (s.corr_id === corrId) return [s.stype, corrId];
      }
    }
    return ["dev", corrId];
  }

  return [null, null];
}

/** Back-compat wrapper: returns commandType string or "pipeline" if no match. */
export function classifyPipelinePrompt(firstPrompt) {
  const [cmdType] = classifyFirstPrompt(firstPrompt);
  return cmdType ?? "pipeline";
}

export function extractCommandTypeFromBranch(branch) {
  if (branch.startsWith("autonomous/")) return "dev";
  if (branch.startsWith("research/"))   return "research";
  if (branch.startsWith("tests/"))      return "test";
  return "unknown";
}

/**
 * Returns all known command types — built-in mechanic types plus any user-configured
 * types from ~/.pipeline/config.json session_classifications. "queue" is always
 * included as a pipeline-mechanic type set by the orchestrator, not by first-prompt
 * classification. Used to derive ORDER (report.mjs) and COMMAND_TYPES (baselines.mjs).
 */
export function getAllCommandTypes() {
  const user = loadUserClassifications();
  const builtinTypes = ["queue", ..._BUILTIN_FIRST_PROMPT_TYPES.map(e => e.type), ..._BUILTIN_SYNTHETIC_TYPES.map(e => e.type)];
  const seen = new Set();
  const all = [];
  for (const t of [...user.map(e => e.type), ...builtinTypes]) {
    if (!seen.has(t)) { seen.add(t); all.push(t); }
  }
  return all;
}

export function loadInteractiveSessionIds(db) {
  return new Set(listAllClaudeSessionIds(db));
}

// Compute orchestrator-worktree path prefixes per branch type at module load
// time. extractCommandTypeFromProject uses these to match a session's cwd to
// the originating session type. Prefixes derive from orchestrator_worktree_base
// — so an operator's custom template flows through automatically.
const _WORKTREE_PREFIXES = (() => {
  const SENTINEL = "__worktree_sentinel__";
  function prefixFor(branchType) {
    const full = orchestratorWorktreePath({
      project: "", projectRoot: "", branch: `${branchType}/${SENTINEL}`,
    });
    const norm = full.toLowerCase().replace(/\\/g, "/");
    const idx  = norm.indexOf(SENTINEL.toLowerCase());
    return idx >= 0 ? norm.slice(0, idx) : "";
  }
  return {
    autonomous: prefixFor("autonomous"),
    research:   prefixFor("research"),
    tests:      prefixFor("tests"),
  };
})();

export function extractCommandTypeFromProject(projectPath, display = "") {
  const displayLower = (display || "").toLowerCase().replace(/^\//, "");
  if (displayLower === "dev" || displayLower === "automate") return "dev";
  if (displayLower === "test" || displayLower === "tests")   return "test";
  if (displayLower === "research")                           return "research";

  const pathNorm = projectPath.toLowerCase().replace(/\\/g, "/");
  const pfxAuto = _WORKTREE_PREFIXES.autonomous;
  if (pfxAuto && pathNorm.includes(pfxAuto)) {
    const suffix = pathNorm.split(pfxAuto).pop() ?? "";
    if (suffix.slice(0, 30).includes("test")) return "test";
    return "dev";
  }
  const pfxRes = _WORKTREE_PREFIXES.research;
  if (pfxRes && pathNorm.includes(pfxRes)) return "research";
  const pfxTests = _WORKTREE_PREFIXES.tests;
  if (pfxTests && pathNorm.includes(pfxTests)) return "test";
  return null;
}

/** Parse timestamp from ISO string or Unix ms. Returns Date or null. */
export function parseTimestamp(tsInput) {
  if (typeof tsInput === "number") {
    return new Date(tsInput);
  }
  if (typeof tsInput === "string") {
    const d = new Date(tsInput.replace("Z", "+00:00"));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Convert project path to Claude's directory naming format. */
function normalizeProjectPath(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

function findSessionFile(projectPath, sessionUuid, _projectsDir) {
  const normalized = normalizeProjectPath(projectPath);
  const projectsDir = _projectsDir ?? join(homedir(), ".claude", "projects");
  for (const candidate of new Set([normalized, normalized.replace(/-+$/, "")])) {
    if (!candidate) continue;
    const f = join(projectsDir, candidate, `${sessionUuid}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** Read a session JSONL, return {turn_count, cache_create_tokens, cache_read_tokens} or null. */
export function readSessionData(projectPath, sessionUuid) {
  try {
    const sessionFile = findSessionFile(projectPath, sessionUuid);
    if (!sessionFile) return null;
    const lines = readFileSync(sessionFile, { encoding: "utf8", flag: "r" }).split("\n");
    let turnCount = 0, cacheCreate = 0, cacheRead = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "user") turnCount++;
      else if (record.type === "assistant") {
        const usage = record.message?.usage ?? {};
        cacheCreate += usage.cache_creation_input_tokens ?? 0;
        cacheRead   += usage.cache_read_input_tokens ?? 0;
      }
    }
    return { turn_count: turnCount, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead };
  } catch {
    return null;
  }
}

/**
 * Parse a session JSONL and return all metadata needed to build a session record.
 * Returns null if no usable records.
 */
export function readSessionFull(sessionFilePath) {
  try {
    const lines = readFileSync(sessionFilePath, { encoding: "utf8", flag: "r" }).split("\n");
    let sessionId = null, gitBranch = null, cwd = null, timestamp = null;
    let userType = "human", turnCount = 0, cacheCreate = 0, cacheRead = 0;
    let firstPrompt = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const rtype = record.type;
      if (!sessionId && record.sessionId) sessionId = record.sessionId;
      if (!timestamp && record.timestamp)  timestamp = record.timestamp;

      if (rtype === "user") {
        turnCount++;
        if (!gitBranch) gitBranch = record.gitBranch ?? null;
        if (!cwd)       cwd = record.cwd ?? null;
        if (record.userType) userType = record.userType;
        if (firstPrompt === null) {
          const content = record.message?.content ?? "";
          let raw = "";
          if (Array.isArray(content)) {
            for (const c of content) {
              // eslint-disable-next-line no-irregular-whitespace
              if (c?.type === "text") { raw = c.text.replace(/^﻿/, ""); break; }
            }
          } else if (typeof content === "string") {
            // eslint-disable-next-line no-irregular-whitespace
            raw = content.replace(/^﻿/, "");
          }
          firstPrompt = raw.split("\n").find(l => l.trim()) ?? raw.split("\n")[0] ?? "";
        }
      } else if (rtype === "assistant") {
        if (!gitBranch) gitBranch = record.gitBranch ?? null;
        if (!cwd)       cwd = record.cwd ?? null;
        const usage = record.message?.usage ?? {};
        cacheCreate += usage.cache_creation_input_tokens ?? 0;
        cacheRead   += usage.cache_read_input_tokens ?? 0;
      }
    }

    if (!sessionId) return null;
    return {
      session_id:           sessionId,
      git_branch:           gitBranch ?? "unknown",
      cwd:                  cwd ?? "",
      timestamp,
      user_type:            userType,
      turn_count:           turnCount,
      cache_create_tokens:  cacheCreate,
      cache_read_tokens:    cacheRead,
      first_prompt:         firstPrompt ?? "",
      session_file:         sessionFilePath,
    };
  } catch {
    return null;
  }
}

/** Read ~/.claude/history.jsonl → array of records. */
export function readHistoryJsonl() {
  const historyPath = join(homedir(), ".claude", "history.jsonl");
  const records = [];
  if (!existsSync(historyPath)) return records;
  const lines = readFileSync(historyPath, { encoding: "utf8" }).split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

/** Count real conversation sessions by mtime in window. */
export function countProjectConversations(windowStart, windowEnd) {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return 0;
  let count = 0;
  const ws = windowStart.getTime() / 1000;
  const we = windowEnd.getTime() / 1000;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsDir, entry.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const mtime = statSync(join(dir, f)).mtimeMs / 1000;
        if (ws <= mtime && mtime < we) count++;
      } catch {}
    }
  }
  return count;
}

/**
 * update-sessions: parse history.jsonl, add new sessions to pipeline.db.
 */
export function updateSessions(db, { historyOverride, _projectsDir } = {}) {
  const historyRecords = historyOverride ?? readHistoryJsonl();
  const existingMap = {};
  for (const r of loadMetricSessions(db)) {
    if (r.session_id) existingMap[r.session_id] = r;
  }
  const spawnMap = loadSpawnMap(db);
  const interactiveIds = loadInteractiveSessionIds(db);

  const sessionsByIdSeen = {};
  for (const record of historyRecords) {
    const sid = record.sessionId ?? "";
    if (sid && !existingMap[sid] && !sessionsByIdSeen[sid]) {
      sessionsByIdSeen[sid] = record;
    }
  }

  const newEntries = Object.entries(sessionsByIdSeen);
  process.stdout.write(`Found ${historyRecords.length} history records\n`);
  process.stdout.write(`Existing sessions: ${Object.keys(existingMap).length}\n`);
  process.stdout.write(`New sessions to process: ${newEntries.length}\n`);

  for (const [sessionId, historyRecord] of newEntries) {
    let timestamp = historyRecord.timestamp ?? new Date().toISOString();
    let branch = null, correlationId = null;
    let durationSeconds = historyRecord.duration ?? 1800;
    const filesIndexed = historyRecord.fileCounts?.totalCount ?? 20;
    const projectPath = historyRecord.project ?? "";

    const sessionFile = projectPath ? findSessionFile(projectPath, sessionId, _projectsDir) : null;
    let full = null, firstPrompt = "";
    if (sessionFile) {
      full = readSessionFull(sessionFile);
      if (full) {
        firstPrompt = full.first_prompt ?? "";
        if (!branch) {
          const jb = full.git_branch;
          if (jb && jb !== "unknown") branch = jb;
        }
      }
    }

    const [prefixType, prefixCorrId] = classifyFirstPrompt(firstPrompt, spawnMap);
    let commandType;
    if (prefixType) {
      commandType = prefixType;
      if (prefixCorrId && !correlationId) correlationId = prefixCorrId;
    } else {
      commandType = "unknown";
      if (branch) commandType = extractCommandTypeFromBranch(branch);
      if (commandType === "unknown") {
        const inferred = extractCommandTypeFromProject(
          historyRecord.project ?? "",
          historyRecord.display ?? "",
        );
        if (inferred) commandType = inferred;
      }
    }

    if (full?.user_type === "external" && ["unknown", null].includes(commandType)) {
      commandType = "slack";
    }

    // claude_sessions presence always wins: UserPromptSubmit only fires in non-`-p` sessions,
    // so anything here is definitionally an interactive session, not a Slack bridge call.
    if (interactiveIds.has(sessionId)) commandType = "interactive";

    let cacheCreate = 0, cacheRead = 0, turnCount = 0;
    let tokenSource = "estimation", estimationMethod = "formula";
    const sessionData = projectPath ? readSessionData(projectPath, sessionId) : null;
    if (sessionData && (sessionData.cache_create_tokens > 0 || sessionData.cache_read_tokens > 0)) {
      cacheCreate     = sessionData.cache_create_tokens;
      cacheRead       = sessionData.cache_read_tokens;
      turnCount       = sessionData.turn_count;
      tokenSource     = "session_jsonl";
      estimationMethod = "actual";
    } else {
      const est = estimateTokens(durationSeconds, commandType, filesIndexed);
      if (!est) continue;
      cacheCreate       = est.create_tokens_est;
      cacheRead         = est.read_tokens_est;
      turnCount         = sessionData?.turn_count ?? 0;
      estimationMethod  = est.estimation_method;
    }

    const cacheReadRatio = cacheCreate > 0 ? cacheRead / cacheCreate : 0;

    appendMetricSession(db, {
      session_id:           sessionId,
      timestamp,
      command_type:         commandType ?? "unknown",
      branch:               branch ?? "unknown",
      correlation_id:       correlationId,
      duration_seconds:     durationSeconds,
      files_indexed:        filesIndexed,
      plan_file:            historyRecord.planFile ?? null,
      cache_create_tokens:  cacheCreate,
      cache_read_tokens:    cacheRead,
      token_source:         tokenSource,
      estimation_method:    estimationMethod,
      cache_read_ratio:     cacheReadRatio,
      turn_count:           turnCount,
    });
    process.stdout.write(`Added session: ${sessionId} (${commandType}, ${durationSeconds}s)\n`);
  }
}

/**
 * update-sessions-projects: scan ~/.claude/projects/ JSONLs for sessions not yet in DB.
 */
export function updateSessionsFromProjects(db) {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) {
    process.stdout.write("No ~/.claude/projects directory found.\n");
    return;
  }

  const existingMap = {};
  for (const r of loadMetricSessions(db)) {
    if (r.session_id) existingMap[r.session_id] = r;
  }
  const spawnMap = loadSpawnMap(db);
  const interactiveIds = loadInteractiveSessionIds(db);

  let added = 0, skippedEmpty = 0;

  const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  for (const pdirName of projectDirs) {
    const pdir = join(projectsDir, pdirName);
    let files;
    try { files = readdirSync(pdir).filter(f => f.endsWith(".jsonl")); }
    catch { continue; }

    for (const fname of files) {
      const sessionUuid = fname.replace(/\.jsonl$/, "");
      if (existingMap[sessionUuid]) continue;

      const sessionFilePath = join(pdir, fname);
      const data = readSessionFull(sessionFilePath);
      if (!data || data.turn_count === 0) { skippedEmpty++; continue; }

      const tsIso = data.timestamp ?? new Date(statSync(sessionFilePath).mtimeMs).toISOString();
      const fileSizeKb = statSync(sessionFilePath).size / 1024;
      const durationSeconds = Math.max(60, Math.trunc(fileSizeKb * 6));

      const branch = data.git_branch;
      const firstPrompt = data.first_prompt ?? "";
      let [commandType, correlationId] = classifyFirstPrompt(firstPrompt, spawnMap);

      if (!commandType) {
        commandType = extractCommandTypeFromBranch(branch);
        if (commandType === "unknown") {
          const inferred = extractCommandTypeFromProject(data.cwd ?? "");
          if (inferred) commandType = inferred;
        }
      }

      if (data.user_type === "external" && ["unknown", null].includes(commandType)) {
        commandType = "slack";
      }

      // claude_sessions presence always wins: UserPromptSubmit only fires in non-`-p` sessions,
      // so anything here is definitionally an interactive session, not a Slack bridge call.
      if (interactiveIds.has(data.session_id)) commandType = "interactive";

      const cc = data.cache_create_tokens;
      const cr = data.cache_read_tokens;
      const cacheReadRatio = cc > 0 ? cr / cc : 0;

      appendMetricSession(db, {
        session_id:          data.session_id,
        timestamp:           tsIso,
        command_type:        commandType ?? "unknown",
        branch,
        correlation_id:      correlationId,
        duration_seconds:    durationSeconds,
        files_indexed:       0,
        plan_file:           null,
        cache_create_tokens: cc,
        cache_read_tokens:   cr,
        token_source:        "session_jsonl",
        estimation_method:   "actual",
        cache_read_ratio:    cacheReadRatio,
        turn_count:          data.turn_count,
      });
      added++;
    }
  }

  process.stdout.write(`Added ${added} sessions from project scan (skipped ${skippedEmpty} empty/init files)\n`);
}
