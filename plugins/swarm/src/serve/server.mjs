// The dashboard's HTTP + SSE server. Read-only over <home>/runs; every route
// segment is validated and re-resolved under the runs root, so a request can
// never name a file outside it. Zero deps — node:http only.
import http from "node:http";
import { readFileSync, readdirSync, existsSync, statSync, watch as fsWatch } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readRun, listRuns } from "../runlog.mjs";
import { readRows, dedupe, aggregate, overall, scoresPath, PRIOR_WEIGHT } from "../scores.mjs";
import { ASPECTS, UNIVERSAL } from "../aspects.mjs";
import { mdToHtml } from "../md_to_html.mjs";
import { renderIconPng, ICON_SIZES } from "./icon.mjs";
import { coverage, reliability, leaders } from "./perf-views.mjs";

const PAGE = fileURLToPath(new URL("./page.html", import.meta.url));
const PERF_JS = fileURLToPath(new URL("./perf.js", import.meta.url));
const SEGMENT_RE = /^[A-Za-z0-9._\[\]~-]+$/;
// The estate view: every live run, plus the newest few finished PER PROJECT — a
// global newest-N let one busy project crowd the others off the list entirely.
const FINISHED_PER_PROJECT = 8;

// A single path segment as the engine writes them (ids, encoded cwds, run names):
// no separators, no dot-only names, nothing a URL decoder could turn into one.
export function safeSegment(s) {
  return typeof s === "string" && SEGMENT_RE.test(s) && s !== "." && s !== "..";
}

function decodeSegments(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const out = [];
  for (const p of parts) {
    let d;
    try { d = decodeURIComponent(p); } catch { return null; }
    if (!safeSegment(d)) return null;
    out.push(d);
  }
  return out;
}

// PNGs rendered once per process; iOS and Android both want raster icons.
const icons = new Map();
const iconPng = (size) => { if (!icons.has(size)) icons.set(size, renderIconPng(size)); return icons.get(size); };

const MANIFEST = {
  name: "swarm",
  short_name: "swarm",
  start_url: "/",
  display: "standalone",
  background_color: "#101219",
  theme_color: "#101219",
  icons: ICON_SIZES.map((s) => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "any" })),
};

export function createServer({ home, cfg, now = Date.now, log = () => {}, _watch = fsWatch, _heartbeatMs = 5000, _debounceMs = 250 }) {
  const runsRoot = resolve(join(home, "runs"));
  const dash = cfg.dashboard || {};
  const quietWarnMs = (cfg.quietWarnSecs ?? 60) * 1000;
  const recentMs = dash.recentMs ?? 30 * 60_000;

  // Resolve a run dir from validated segments and prove it sits under the root.
  const runDir = (project, name) => {
    const dir = resolve(runsRoot, project, name);
    return dir.startsWith(runsRoot + sep) ? dir : null;
  };

  // ── SSE hub ────────────────────────────────────────────────────────────────
  const clients = new Set();
  const runWatchers = new Map(); // dir -> watcher
  let rootWatcher = null;
  let heartbeat = null;
  const pending = new Map(); // dir -> timer

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  const scheduleRun = (run) => {
    clearTimeout(pending.get(run.dir));
    pending.set(run.dir, setTimeout(() => {
      pending.delete(run.dir);
      broadcast("run", { project: run.project, name: run.name });
    }, _debounceMs));
  };
  const projectWatchers = new Map(); // project dir -> watcher (a new run dir appears here, not at the root)
  const onRootOrProject = () => { refreshWatchers(); broadcast("runs", {}); };
  const refreshWatchers = () => {
    // fs.watch is not recursive: the root sees new PROJECT dirs, each project dir sees
    // new RUN dirs, and each active run's run.log sees its own appends.
    let projects = [];
    try { projects = readdirSync(runsRoot).map((p) => join(runsRoot, p)); } catch {}
    for (const [dir, w] of projectWatchers) if (!projects.includes(dir)) { try { w.close(); } catch {} projectWatchers.delete(dir); }
    for (const dir of projects) {
      if (projectWatchers.has(dir)) continue;
      try { projectWatchers.set(dir, _watch(dir, onRootOrProject)); } catch (e) { log(`watch ${dir}: ${e.message}`); }
    }
    const active = new Map(listRuns(home, { now: now(), recentMs }).filter((r) => r.active).map((r) => [r.dir, r]));
    for (const [dir, w] of runWatchers) if (!active.has(dir)) { try { w.close(); } catch {} runWatchers.delete(dir); }
    for (const [dir, run] of active) {
      if (runWatchers.has(dir)) continue;
      try {
        runWatchers.set(dir, _watch(join(dir, "run.log"), () => scheduleRun(run)));
      } catch (e) { log(`watch ${dir}: ${e.message}`); }
    }
  };
  const startHub = () => {
    if (rootWatcher) return;
    try {
      rootWatcher = _watch(runsRoot, onRootOrProject);
    } catch (e) { log(`watch ${runsRoot}: ${e.message}`); rootWatcher = { close() {} }; }
    refreshWatchers();
    heartbeat = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, _heartbeatMs);
  };
  const stopHub = () => {
    if (!rootWatcher) return;
    try { rootWatcher.close(); } catch {}
    rootWatcher = null;
    for (const w of runWatchers.values()) { try { w.close(); } catch {} }
    runWatchers.clear();
    for (const w of projectWatchers.values()) { try { w.close(); } catch {} }
    projectWatchers.clear();
    clearInterval(heartbeat);
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  };

  // ── responses ─────────────────────────────────────────────────────────────
  const send = (res, status, body, type = "application/json; charset=utf-8") => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const notFound = (res) => send(res, 404, { error: "not found" });

  // grading.enabled drives the page's Performance entry: greyed when off, the
  // store still readable so old grades are not hidden.
  const grading = cfg.grading?.enabled === true;

  const routes = {
    "/api/runs": (res) => {
      const seen = new Map();
      const picked = listRuns(home, { now: now(), recentMs }).filter((r) => {
        if (r.active) return true;
        const n = seen.get(r.project) || 0;
        seen.set(r.project, n + 1);
        return n < FINISHED_PER_PROJECT;
      });
      const rows = picked.map((r) => {
        const run = readRun(r.dir, { now: now(), quietWarnMs, recentMs });
        return {
          project: r.project, name: r.name, active: r.active, aborted: r.aborted, mtimeMs: r.mtimeMs,
          startedMs: run?.startedMs ?? null, finishedMs: run?.finishedMs ?? null,
          byState: run?.totals.byState ?? {}, leaves: run?.tasks.length ?? 0, waves: run?.waves.length ?? 0,
          tokens: run ? run.tasks.reduce((n, t) => n + (t.tokens ? (t.tokens.input || 0) + (t.tokens.output || 0) + (t.tokens.cacheCreation || 0) : 0), 0) : 0,
          hasDigest: !!(run?.digestPath || run?.reportPath),
        };
      });
      send(res, 200, { runs: rows, recentMs, grading });
    },
  };

  // ── performance: the score store, ranked exactly as `swarm perf` ranks it ──
  // The maths stays in scores.mjs (overall / aggregate); this only reads the
  // store — re-parsed when its mtime moves, a grade lands between requests — and
  // hands both tables over so the page switches aspect without a round trip.
  const scoresFile = scoresPath({ ...process.env, SWARM_HOME: home });
  let scoreCache = { mtimeMs: -1, rows: [] };
  const scoreRows = () => {
    let mtimeMs = 0;
    try { mtimeMs = statSync(scoresFile).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs !== scoreCache.mtimeMs) scoreCache = { mtimeMs, rows: readRows(scoresFile) };
    return scoreCache.rows;
  };
  const perf = (res, url) => {
    const q = (k) => url.searchParams.get(k) || undefined;
    const aspect = q("aspect"), model = q("model"), domain = q("domain");
    if (aspect && !ASPECTS.includes(aspect)) return send(res, 400, { error: `unknown aspect ${aspect}`, aspects: ASPECTS });
    if (!grading) return send(res, 200, { grading, path: scoresFile }); // off means off: nothing ranked, nothing listed
    const rows = scoreRows();
    const live = dedupe(rows);
    const domains = [...new Set(live.map((r) => r.domain).filter(Boolean))].sort();
    const report = aggregate(rows, { aspect, model, domain });
    send(res, 200, {
      grading, path: scoresFile, lines: rows.length, rows: live.length, priorWeight: PRIOR_WEIGHT,
      aspects: ASPECTS, universals: UNIVERSAL, domains,
      filters: report.filters,
      overall: overall(rows, { model, domain }).cells,
      report: report.aspects,
      views: { coverage: coverage(report), reliability: reliability(live), leaders: leaders(report) },
    });
  };

  const handle = (req, res) => {
    const url = new URL(req.url, "http://x");
    if (dash.token && url.searchParams.get("t") !== dash.token) return send(res, 401, { error: "token" });
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    const p = url.pathname;

    if (p === "/") {
      if (!existsSync(PAGE)) return send(res, 500, "page.html missing", "text/plain");
      return send(res, 200, readFileSync(PAGE, "utf8"), "text/html; charset=utf-8");
    }
    if (p === "/manifest.webmanifest") return send(res, 200, MANIFEST, "application/manifest+json");
    const icon = /^\/icon-(\d+)\.png$/.exec(p);
    if (icon) {
      const size = Number(icon[1]);
      if (!ICON_SIZES.includes(size)) return notFound(res);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(iconPng(size));
    }
    if (p === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      startHub();
      req.on("close", () => { clients.delete(res); if (!clients.size) stopHub(); });
      return;
    }
    if (p === "/perf.js") {
      if (!existsSync(PERF_JS)) return notFound(res);
      return send(res, 200, readFileSync(PERF_JS, "utf8"), "text/javascript; charset=utf-8");
    }
    if (p === "/api/perf") return perf(res, url);
    if (routes[p]) return routes[p](res);

    // A trailing slash is what the URL parser leaves behind after collapsing an
    // encoded dot-segment (%2e%2e) — never a resource, so never served.
    if (!p.startsWith("/api/runs/") || p.endsWith("/")) return notFound(res);
    const seg = decodeSegments(p.slice("/api/runs/".length));
    if (!seg || seg.length < 2) return notFound(res);
    const dir = runDir(seg[0], seg[1]);
    if (!dir) return notFound(res);

    if (seg.length === 2) {
      const run = readRun(dir, { now: now(), quietWarnMs, recentMs });
      return run ? send(res, 200, run) : notFound(res);
    }
    if (seg.length === 3 && seg[2] === "digest") {
      const md = ["report.md", "digest.md"].map((f) => join(dir, f)).find(existsSync);
      if (!md) return notFound(res);
      return send(res, 200, mdToHtml(readFileSync(md, "utf8"), { title: `${seg[1]} · digest` }), "text/html; charset=utf-8");
    }
    if (seg.length === 4 && seg[2] === "leaves") {
      const file = resolve(dir, "results", `${seg[3]}.json`);
      if (!file.startsWith(dir + sep) || !existsSync(file)) return notFound(res);
      let r;
      try { r = JSON.parse(readFileSync(file, "utf8")); } catch { return notFound(res); }
      const { id, model, ok, exit, durationMs, tokens, costUsd, numTurns, output, outputJson, citations, worktree, cwd } = r;
      return send(res, 200, { id, model, ok, exit, durationMs, tokens, costUsd, numTurns, output, outputJson, citations, worktree, cwd });
    }
    return notFound(res);
  };

  const server = http.createServer((req, res) => {
    try { handle(req, res); } catch (e) { log(`${req.url}: ${e.message}`); try { send(res, 500, { error: "internal" }); } catch {} }
  });
  server.on("close", stopHub);
  return server;
}
