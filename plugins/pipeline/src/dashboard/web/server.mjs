// Lightweight read+write web dashboard. node:http server, plain HTML +
// inline JS (no external CDN), JSON endpoints. POST handlers shell out
// to the pipeline CLI — same affordances as the TUI action menu.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, isAbsolute, join as pathJoin, relative } from "node:path";
import { existsSync, unlinkSync, watchFile, unwatchFile } from "node:fs";
import { homedir } from "node:os";
import { connectUnified, close, rowsList, rowGet } from "../../../scripts/pipeline-db/index.mjs";
import { loadPipelineConfig } from "../../pipeline-config.mjs";
import { projectList } from "../../../scripts/pipeline-db/projects.mjs";
import { loadOrchState } from "../shared/load-orch-state.mjs";
import { loadActiveSessions } from "../shared/load-sessions.mjs";
import { loadProgressBySlug, loadStepsBySlug, sliceSteps, progressKey } from "../shared/load-progress.mjs";
import { loadGitLog } from "../shared/load-git-log.mjs";
import { loadAgentLog } from "../shared/load-agent-log.mjs";
import { loadBacklog } from "../shared/load-backlog.mjs";
import { agentsViewModel } from "../shared/view-model/agents.mjs";
import { pipelineViewModel, createTransitionTracker } from "../shared/view-model/pipeline.mjs";
import { orchViewModel } from "../shared/view-model/orch.mjs";
import { renderIndex } from "./templates.mjs";

// One stage-transition tracker per project, persisted across requests so the
// shimmer effect survives the client's poll cadence. The web client can't
// hold transition state itself (each /api/state response is stateless), so
// the server owns it — same tracker the TUI uses, fed once per payload build.
const _trackers = new Map();
function _trackerFor(project) {
  let t = _trackers.get(project);
  if (!t) { t = createTransitionTracker(); _trackers.set(project, t); }
  return t;
}

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
  if (!project) return { project: null, rows: [], sessions: [], progress: {}, orch: null, gitLog: [], agents: [], pipeline: { counts: { active: 0, queued: 0, done: 0 }, rows: [] }, orchView: null };
  const dbRows    = rowsList(db, projectName) || [];
  const backlogRows = loadBacklog(db, projectName);
  const rows      = _sortRows([...dbRows, ...backlogRows]);
  const sessions  = loadActiveSessions(db, projectName);
  const slugs     = sessions.filter(s => s.is_active === 1 && progressKey(s))
    .map(progressKey);
  const progress  = loadProgressBySlug(db, slugs);
  const orch      = loadOrchState();
  const gitLog    = loadGitLog(project.root_path, { limit: 8 });
  const agentLog  = loadAgentLog(sessions, project.root_path, { limit: 500 });

  // Derived view-models — same shared functions the TUI consumes, so the two
  // surfaces can't drift. The server holds the transition tracker (the client
  // is stateless between polls). The web omits pidAlive: cross-process liveness
  // is the orchestrator/DB's job, and is_active already reflects it here.
  const agentsBase = agentsViewModel(sessions, progress);
  const agents = agentsBase.map(a => {
    const s    = sessions.find(s => s.is_active === 1 && s.feature === a.feature);
    const slug = s ? progressKey(s) : null;
    const { visible, overflow, overflowDone } = sliceSteps(loadStepsBySlug(db, slug));
    return { ...a, steps: visible, stepsOverflow: overflow, stepsOverflowDone: overflowDone };
  });
  const pipeline  = pipelineViewModel(rows, { showAll: true, sessions, tracker: _trackerFor(projectName) });
  const orchView = orchViewModel(orch);

  return { project, rows, sessions, progress, orch, gitLog, agentLog, agents, pipeline, orchView };
}

export function startWebServer({ paths, host, port } = {}) {
  const cfgPath = paths?.configDir
    ? pathJoin(paths.configDir, "config.json")
    : pathJoin(homedir(), ".pipeline", "config.json");
  const db = connectUnified(paths);

  // CLI flags lock the bind; config changes never override an explicit --host/--port.
  const cliHost = host;
  const cliPort = port;
  // Mutable bind state -- the request handler reads bind.host/.port so a
  // config-driven restart does not require rebuilding the handler closure.
  const bind = { host: undefined, port: undefined };

  const resolveBind = () => {
    const cfg = loadPipelineConfig(cfgPath);
    return {
      host: cliHost !== undefined ? cliHost : (cfg?.web?.host ?? "127.0.0.1"),
      port: cliPort !== undefined ? cliPort : (cfg?.web?.port ?? 8765),
    };
  };

  const requestHandler = async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${bind.host}:${bind.port}`}`);
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
  };

  // Default: loopback-only (127.0.0.1). Pass --host 0.0.0.0 or --host :: to bind all interfaces.
  // Map well-known loopback addresses to "localhost" for readability; echo
  // every other host verbatim so the banner reflects the actual bind.
  const displayHost = (h) => (h === "127.0.0.1" || h === "::1") ? "localhost" : h;
  let server = null;
  const listenOn = ({ host: h, port: p }) => {
    server = createServer(requestHandler);
    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        process.stderr.write(`pipeline dashboard web: port ${p} already in use — another dashboard is already running. Visit http://${displayHost(h)}:${p}/pipeline\n`);
        process.exit(2);
      }
      throw err;
    });
    server.listen(p, h, () => {
      bind.host = h;
      bind.port = p;
      process.stdout.write(`pipeline dashboard web: http://${displayHost(h)}:${p}/pipeline\n`);
    });
  };

  listenOn(resolveBind());

  // Hot-reload: re-resolve the bind when ~/.pipeline/config.json changes and
  // restart the listener if host/port differ. fs.watchFile polls (vs fs.watch
  // event-based) so it survives the atomic .tmp -> rename pattern that
  // updatePipelineConfig uses; 2s interval is plenty for config tweaks.
  const onCfgChange = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    const next = resolveBind();
    if (next.host === bind.host && next.port === bind.port) return;
    process.stdout.write(`pipeline dashboard web: config changed — restarting on ${next.host}:${next.port}\n`);
    try { server.close(); } catch {}
    listenOn(next);
  };
  watchFile(cfgPath, { interval: 2000 }, onCfgChange);

  const shutdown = () => {
    try { unwatchFile(cfgPath, onCfgChange); } catch {}
    try { server?.close(); } catch {}
    try { close(db); } catch {}
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}
