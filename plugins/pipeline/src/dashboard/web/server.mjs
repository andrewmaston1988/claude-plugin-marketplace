// Lightweight read+write web dashboard. node:http server, plain HTML +
// inline JS (no external CDN), JSON endpoints. POST handlers shell out
// to the pipeline CLI — same affordances as the TUI action menu.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, isAbsolute, join as pathJoin, relative } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { connectUnified, close, rowsList, rowGet } from "../../../scripts/pipeline-db/index.mjs";
import { loadPipelineConfig } from "../../pipeline-config.mjs";
import { projectList } from "../../../scripts/pipeline-db/projects.mjs";
import { loadOrchState } from "../shared/load-orch-state.mjs";
import { loadActiveSessions } from "../shared/load-sessions.mjs";
import { loadProgressBySlug } from "../shared/load-progress.mjs";
import { loadGitLog } from "../shared/load-git-log.mjs";
import { loadAgentLog } from "../shared/load-agent-log.mjs";
import { loadBacklog } from "../shared/load-backlog.mjs";
import { renderIndex } from "./templates.mjs";

const HERE         = fileURLToPath(new URL(".", import.meta.url));
const PIPELINE_BIN = resolve(HERE, "..", "..", "..", "bin", "pipeline.mjs");
const ORCH_ENTRY   = resolve(HERE, "..", "..", "..", "scripts", "orchestrator", "index.mjs");

const STAGE_ORDER = ["merge","manual","test","review","dev","research","queued","backlog","done"];
function _stageRank(r) { const i = STAGE_ORDER.indexOf(r.stage); return i < 0 ? 99 : i; }

function _sortRows(rows) {
  return rows.slice().sort((a, b) => _stageRank(a) - _stageRank(b));
}

function _json(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
function _html(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}
function _text(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

// CLI shell-out with a hard timeout — a hung pipeline subcommand should
// never block a request handler indefinitely.
const RUN_CLI_TIMEOUT_MS = 30_000;
function _runCli(argv) {
  return new Promise((resolveRun) => {
    const proc = spawn(process.execPath, [PIPELINE_BIN, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
      resolveRun({ code: -1, stdout: out, stderr: err + `\n[runCli timeout after ${RUN_CLI_TIMEOUT_MS}ms]` });
    }, RUN_CLI_TIMEOUT_MS);
    proc.stdout.on("data", (b) => out += b.toString());
    proc.stderr.on("data", (b) => err += b.toString());
    proc.on("close", (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolveRun({ code, stdout: out, stderr: err });
    });
    proc.on("error", (e) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolveRun({ code: -1, stdout: "", stderr: String(e) });
    });
  });
}

// Reject path traversal: the plan file must resolve inside the registered
// project's root_path. Symlink escapes can still slip through; callers must
// not rely on this alone for security boundaries.
function _planFileInProject(db, projectName, planFile) {
  if (!planFile || typeof planFile !== "string") return null;
  const project = projectList(db).find(p => p.name === projectName);
  if (!project || !project.root_path) return null;
  const root = resolve(project.root_path);
  const resolved = isAbsolute(planFile) ? resolve(planFile) : resolve(root, planFile);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

async function _readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function _buildPayload(db, projectName) {
  const project   = projectList(db).find(p => p.name === projectName);
  if (!project) return { project: null, rows: [], sessions: [], progress: {}, orch: null, gitLog: [] };
  const dbRows    = rowsList(db, projectName) || [];
  const backlogRows = loadBacklog(db, projectName);
  const rows      = _sortRows([...dbRows, ...backlogRows]);
  const sessions  = loadActiveSessions(db, projectName);
  const slugs     = sessions.filter(s => s.is_active === 1 && s.correlation_id)
    .map(s => s.correlation_id);
  const progress  = loadProgressBySlug(db, slugs);
  const orch      = loadOrchState();
  const gitLog    = loadGitLog(project.root_path, { limit: 8 });
  const agentLog  = loadAgentLog(sessions, project.root_path, { limit: 500 });
  return { project, rows, sessions, progress, orch, gitLog, agentLog };
}

export function startWebServer({ paths, host, port } = {}) {
  const cfgPath = paths?.configDir
    ? pathJoin(paths.configDir, "config.json")
    : pathJoin(homedir(), ".pipeline", "config.json");
  const cfg = loadPipelineConfig(cfgPath);
  const resolvedHost = host !== undefined ? host : "127.0.0.1";
  const resolvedPort = port !== undefined ? port : (cfg?.web?.port ?? 8765);
  const db = connectUnified(paths);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${resolvedHost}:${resolvedPort}`}`);
      const path = url.pathname;
      const projectName = url.searchParams.get("project") || "";

      // ── GET routes ─────────────────────────────────────────────────────
      if (req.method === "GET" && (path === "/" || path === "/pipeline")) {
        const projects = projectList(db).filter(p => p.enabled === 1);
        const active = projectName && projects.find(p => p.name === projectName)
          ? projectName
          : (projects[0]?.name || "");
        return _html(res, 200, renderIndex({ projects, active }));
      }
      if (req.method === "GET" && path === "/api/health") {
        return _json(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/projects") {
        return _json(res, 200, { projects: projectList(db) });
      }
      if (req.method === "GET" && path === "/api/state") {
        if (!projectName) return _json(res, 400, { error: "project required" });
        return _json(res, 200, _buildPayload(db, projectName));
      }

      // ── POST action routes ─────────────────────────────────────────────
      if (req.method === "POST") {
        const body = await _readBody(req);
        if (path === "/api/action/stage-set") {
          const { project, feature, stage } = body;
          if (!project || !feature || !stage) return _json(res, 400, { error: "project, feature, stage required" });
          const r = await _runCli(["stage-set", project, feature, stage]);
          return _json(res, r.code === 0 ? 200 : 500, r);
        }
        if (path === "/api/action/queue-plan") {
          const { project, planFile, type } = body;
          if (!project || !planFile) return _json(res, 400, { error: "project, planFile required" });
          const safe = _planFileInProject(db, project, planFile);
          if (!safe) return _json(res, 400, { error: "planFile must be inside the project root_path" });
          const args = ["queue-plan", project, safe];
          if (type) args.push("--type", type);
          const r = await _runCli(args);
          return _json(res, r.code === 0 ? 200 : 500, r);
        }
        if (path === "/api/action/row-delete") {
          const { project, feature } = body;
          if (!project || !feature) return _json(res, 400, { error: "project, feature required" });
          // Authoritative plan_file path comes from the DB row, NOT the
          // request body. This closes the TOCTOU window where the request
          // could ask the server to unlink an arbitrary path.
          let trustedPlanFile = null;
          try {
            const row = rowGet(db, project, feature);
            if (row && row.plan_file) {
              trustedPlanFile = _planFileInProject(db, project, row.plan_file);
            }
          } catch {}
          const r = await _runCli(["row-delete", project, feature]);
          if (trustedPlanFile && existsSync(trustedPlanFile)) {
            try { unlinkSync(trustedPlanFile); } catch {}
          }
          return _json(res, r.code === 0 ? 200 : 500, r);
        }
        if (path === "/api/action/done") {
          const { project, feature } = body;
          if (!project || !feature) return _json(res, 400, { error: "project, feature required" });
          const r = await _runCli(["done", project, feature]);
          return _json(res, r.code === 0 ? 200 : 500, r);
        }
        if (path === "/api/action/orch-start") {
          // Spawn detached so it outlives this request handler.
          spawn(process.execPath, [ORCH_ENTRY], { stdio: "ignore", detached: true }).unref();
          return _json(res, 200, { code: 0, stdout: "orchestrator started", stderr: "" });
        }
        if (path === "/api/action/orch-stop") {
          // Same 30s timeout as _runCli — a hung orch --shutdown shouldn't
          // wedge the request handler.
          const proc = spawn(process.execPath, [ORCH_ENTRY, "--shutdown"], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "", err = "", timedOut = false;
          proc.stdout.on("data", (b) => out += b.toString());
          proc.stderr.on("data", (b) => err += b.toString());
          const code = await new Promise(resolveStop => {
            const timer = setTimeout(() => {
              timedOut = true;
              try { proc.kill(); } catch {}
              resolveStop(-1);
            }, RUN_CLI_TIMEOUT_MS);
            proc.on("close", (c) => { if (!timedOut) { clearTimeout(timer); resolveStop(c); } });
          });
          if (timedOut) err += `\n[orch-stop timeout after ${RUN_CLI_TIMEOUT_MS}ms]`;
          return _json(res, code === 0 ? 200 : 500, { code, stdout: out, stderr: err });
        }
      }

      return _text(res, 404, "not found");
    } catch (e) {
      return _text(res, 500, `server error: ${e.message}`);
    }
  });

  // Bind to all interfaces (IPv4 0.0.0.0 + IPv6 ::) when no host given —
  // so `localhost:PORT` works whether the browser resolves to 127.0.0.1
  // (IPv4) or ::1 (IPv6). The displayed URL uses `localhost` so it's
  // protocol-agnostic for the user.
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      process.stderr.write(`pipeline dashboard web: port ${resolvedPort} already in use — another dashboard is already running. Visit http://localhost:${resolvedPort}/pipeline\n`);
      process.exit(2);
    }
    throw err;
  });
  server.listen(resolvedPort, resolvedHost, () => {
    const displayHost = resolvedHost;
    process.stdout.write(`pipeline dashboard web: http://${displayHost}:${resolvedPort}/pipeline\n`);
  });

  const shutdown = () => {
    try { server.close(); } catch {}
    try { close(db); } catch {}
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}
