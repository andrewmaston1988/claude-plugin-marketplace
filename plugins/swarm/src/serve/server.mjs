// The dashboard's HTTP + SSE server. Read-only over <home>/runs; every route
// segment is validated and re-resolved under the runs root, so a request can
// never name a file outside it. Zero deps — node:http only.
import http from "node:http";
import { Worker } from "node:worker_threads";
import { readFileSync, readdirSync, existsSync, statSync, watch as fsWatch } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readRun, projectKeys, resultSuperseded, resolveTaskId } from "../runlog.mjs";
import { DIGEST_ID } from "../digest.mjs";
import { readRows, hideDisabledRows, dedupe, aggregate, overall, scoresPath, PRIOR_WEIGHT } from "../scores.mjs";
import { ASPECTS, UNIVERSAL } from "../aspects.mjs";
import { costRowsFor, costProvidersFor, readSnapshots, usageHistoryPath, resolveBands } from "../cost.mjs";
import { rateCardStorePath, rateCards, refreshStaleRateCards } from "../rate-card.mjs";
import { modelRoster, refreshRoster } from "../roster.mjs";
import { defaultProviderRegistry } from "../default-providers.mjs";
import { mdToHtml } from "../md_to_html.mjs";
import { renderIconPng, ICON_SIZES } from "./icon.mjs";
import { coverage, reliability, leaders, rankCells } from "./perf-views.mjs";
import { costView } from "../cost-view.mjs";
import { projectGrouping } from "./grouping.mjs";
import { createWorkerEstate, filterRuns } from "./estate.mjs";
import { createLogger } from "./log.mjs";
import { enabledProviderIds, providerConfig } from "../providers.mjs";
import { logosScript } from "./logos.mjs";
import { PAGE, pageHtml } from "./page-assets.mjs";

// The three boot scripts served as-is; /logos.js is generated, so it stays a route.
const JS_ASSETS = {
  "/perf.js": fileURLToPath(new URL("./perf.js", import.meta.url)),
  "/desktop.js": fileURLToPath(new URL("./desktop.js", import.meta.url)),
  "/live.js": fileURLToPath(new URL("./live.js", import.meta.url)),
};
const SEGMENT_RE = /^[A-Za-z0-9._\[\]~-]+$/;
// The estate view: every live run, plus the newest few finished PER DISPLAY GROUP — a
// global newest-N let one busy project crowd the others off the list entirely.
// dashboard.finishedPerProject overrides the default.
const FINISHED_PER_PROJECT = 10;
// A handle can silently stop delivering (server.mjs's own long-standing note on the
// old hub poll) — this just re-creates run.log watchers from the latest snapshot.
const WATCHER_RECOVERY_MS = 10_000;

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
  launch_handler: { client_mode: "navigate-existing" },
  background_color: "#101219",
  theme_color: "#101219",
  icons: ICON_SIZES.map((s) => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "any" })),
};

export function createServer({ home, cfg, now = Date.now, log = () => {}, _watch = fsWatch, _heartbeatMs = 5000, _debounceMs = 250, _pollMs, _projectKeys = projectKeys, _estate, _Worker = Worker, _setTimeout = setTimeout, _firstWaitMs = 5000, _readProviderUsage, _refreshPrices = refreshStaleRateCards, _modelRoster = modelRoster, _refreshRoster = refreshRoster }) {
  const runsRoot = resolve(join(home, "runs"));
  const dash = cfg.dashboard || {};
  const quietWarnMs = (cfg.quietWarnSecs ?? 60) * 1000;
  const heartbeatMs = Math.max(50, (cfg.heartbeatSecs ?? 15) * 1000);
  const pollMs = _pollMs ?? dash.livenessPollMs ?? 10_000;
  const finishedPerProject = dash.finishedPerProject ?? FINISHED_PER_PROJECT;
  const dlog = createLogger({ logDir: home }).log;

  // Resolve a run dir from validated segments and prove it sits under the root.
  const runDir = (project, name) => {
    const dir = resolve(runsRoot, project, name);
    return dir.startsWith(runsRoot + sep) ? dir : null;
  };

  // Holds the latest snapshot for the server's lifetime — independent of whether any
  // SSE client is connected, since /api/runs needs it either way.
  const estate = _estate ?? createWorkerEstate({ home, pollMs, heartbeatMs, quietWarnMs, dlog, _Worker, _setTimeout, _firstWaitMs });
  let lastRows = [];
  estate.onSnapshot((s) => {
    lastRows = s.rows;
    if (started) refreshRunWatchers(s.rows);
    broadcast("runs", {});
  });

  // ── SSE hub ────────────────────────────────────────────────────────────────
  const clients = new Set();
  const runWatchers = new Map(); // dir -> watcher
  let rootWatcher = null;
  let heartbeat = null;
  let poll = null;
  // Hub liveness is its own flag, NOT `rootWatcher != null`: a watcher handle stays
  // non-null after it stops delivering, so gating on it let a dead hub refuse every
  // rebuild — the run a client never saw appear.
  let started = false;
  const pending = new Map(); // dir -> timer

  // A broken client must not throw through the loop and skip the rest (D5).
  const drop = (res) => { clients.delete(res); if (!clients.size) stopHub(); };
  const write1 = (res, s) => { try { res.write(s); } catch { drop(res); } };
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) write1(res, frame);
  };
  const scheduleRun = (run) => {
    clearTimeout(pending.get(run.dir));
    pending.set(run.dir, setTimeout(() => {
      pending.delete(run.dir);
      broadcast("run", { project: run.project, name: run.name });
    }, _debounceMs));
  };
  const projectWatchers = new Map(); // project dir -> watcher (a new run dir appears here, not at the root)
  const onRootOrProject = () => { refreshProjectWatchers(); estate.refresh(); };
  const refreshProjectWatchers = () => {
    // fs.watch is not recursive: the root sees new PROJECT dirs, each project dir sees
    // new RUN dirs. Run.log watchers are driven by snapshot rows, not this scan.
    let projects = [];
    try { projects = readdirSync(runsRoot).map((p) => join(runsRoot, p)); } catch {}
    for (const [dir, w] of projectWatchers) if (!projects.includes(dir)) { try { w.close(); } catch {} projectWatchers.delete(dir); }
    for (const dir of projects) {
      if (projectWatchers.has(dir)) continue;
      try { projectWatchers.set(dir, _watch(dir, onRootOrProject)); } catch (e) { log(`watch ${dir}: ${e.message}`); }
    }
  };
  // Takes the active set from the snapshot's rows, never a fresh listRuns — the
  // estate worker already did that scan. `dir` is recomputed via runDir since
  // snapshot rows carry no absolute paths.
  const refreshRunWatchers = (rows) => {
    const active = new Map();
    for (const r of rows) {
      if (!r.active) continue;
      const dir = runDir(r.project, r.name);
      if (dir) active.set(dir, r);
    }
    for (const [dir, w] of runWatchers) if (!active.has(dir)) { try { w.close(); } catch {} runWatchers.delete(dir); }
    for (const [dir, run] of active) {
      if (runWatchers.has(dir)) continue;
      try {
        runWatchers.set(dir, _watch(join(dir, "run.log"), () => {
          estate.refresh();
          scheduleRun({ dir, project: run.project, name: run.name });
        }));
      } catch (e) { log(`watch ${dir}: ${e.message}`); }
    }
  };
  const startHub = () => {
    if (started) return;
    started = true;
    try {
      rootWatcher = _watch(runsRoot, onRootOrProject);
    } catch (e) { log(`watch ${runsRoot}: ${e.message}`); rootWatcher = { close() {} }; }
    refreshProjectWatchers();
    refreshRunWatchers(lastRows);
    // `lastRows` is only set by a snapshot notification, which may not have fired yet
    // (the estate's own first build can predate this hub ever starting) — pull the
    // current snapshot directly too, so the first client is never missing a watcher.
    estate.current().then((s) => { lastRows = s.rows; if (started) refreshRunWatchers(s.rows); }).catch(() => {});
    heartbeat = setInterval(() => { for (const res of clients) write1(res, ": ping\n\n"); }, _heartbeatMs);
    // A handle can silently stop delivering; this just re-creates run.log watchers
    // from the latest snapshot. Data freshness is the worker's own poll now.
    poll = setInterval(() => refreshRunWatchers(lastRows), WATCHER_RECOVERY_MS);
  };
  const stopHub = () => {
    if (!started) return;
    started = false;
    try { rootWatcher?.close(); } catch {}
    rootWatcher = null;
    for (const w of runWatchers.values()) { try { w.close(); } catch {} }
    runWatchers.clear();
    for (const w of projectWatchers.values()) { try { w.close(); } catch {} }
    projectWatchers.clear();
    clearInterval(heartbeat);
    clearInterval(poll);
    poll = null;
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

  // The prompt a task was authored with, from the run's manifest snapshot, resolved by
  // the same id parser topology() uses. Null when the run has no snapshot or the id is
  // not in it.
  const authoredPrompt = (dir, id) => {
    let m;
    try { m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { return null; }
    // The digest is a `digest` block, never a member of tasks, so it would otherwise
    // 404 while in flight. Its instructions are the authored steer; the prompt actually
    // dispatched is assembled from every leaf's results at run time.
    if (id === DIGEST_ID) return m?.digest?.instructions || null;
    return resolveTaskId(id, m?.tasks).def?.prompt || null;
  };

  // grading.enabled drives the page's Performance entry: greyed when off, the
  // store still readable so old grades are not hidden.
  const grading = cfg.grading?.enabled === true;

  const routes = {
    "/api/runs": async (res, url) => {
      const s = await estate.current();
      // `expand` names display GROUPS the page wants uncapped (the Show-all rows).
      // Unknown names match no group and are simply ignored — the value never
      // reaches a path join, so a stale bookmark cannot fault the estate view.
      const expanded = new Set(url.searchParams.getAll("expand"));
      const { rows, finishedTotals } = filterRuns(s.rows, { finishedPerProject, expanded });
      send(res, 200, { runs: rows, finishedTotals, clockMs: dash.clockMs ?? 1000, uiPollMs: dash.uiPollMs ?? 5000, usagePollMs: dash.usagePollMs ?? 60000, statsPollMs: dash.statsPollMs ?? 300000, grading });
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
    if (mtimeMs !== scoreCache.mtimeMs) scoreCache = { mtimeMs, rows: hideDisabledRows(readRows(scoresFile), cfg, rosterRegistry, rosterRows()) };
    return scoreCache.rows;
  };
  // The cost half, cached the same way: snapshots re-read when the history's
  // mtime moves, the derivation (pure, cheap) on every request.
  const costFile = usageHistoryPath({ ...process.env, SWARM_HOME: home });
  const rateCardPath = rateCardStorePath({ ...process.env, SWARM_HOME: home });
  let priceRefreshInFlight = false;
  let costCache = { mtimeMs: -1, snaps: [] };
  // The roster each provider is asked to price, so a scored model the table does
  // not list still draws an `unpriced` ROW rather than a blank one. Read through
  // the one reader: a raw parse of the cache file cannot see a local provider's
  // rows, which live in a catalog this process never read.
  const rosterEnv = { ...process.env, SWARM_HOME: home };
  const rosterRegistry = defaultProviderRegistry();
  const enabledProviders = enabledProviderIds(cfg, rosterRegistry);
  let rosterRefreshInFlight = false;
  const rosterRows = () => {
    try {
      return _modelRoster({ env: rosterEnv, config: cfg, registry: rosterRegistry }).models;
    } catch {
      // Display-only: a corrupt roster renders empty; the CLI is the loud path.
      return [];
    }
  };
  const costRoster = () => {
    const byProvider = {};
    for (const row of rosterRows()) {
      if (!row?.model) continue;
      (byProvider[row.provider || "ollama"] ||= []).push(row.model);
    }
    return byProvider;
  };
  const costRows = () => {
    let mtimeMs = 0;
    try { mtimeMs = statSync(costFile).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs !== costCache.mtimeMs) costCache = { mtimeMs, snaps: readSnapshots(costFile) };
    // Every provider with a cost source, each on its own axis: the meter banks
    // its own names (the score store carries the roster's cloud forms — the same
    // mapping discovery uses, never a second rule), and the rate cards price
    // theirs. `costView` sections the result by provider.
    const roster = costRoster();
    // Renewed off the request path like the prices: the network providers are not
    // cheap, and a dashboard open on a long-lived session would otherwise age past
    // its own TTL. The reader itself is unmemoised — a warm 200-row read is
    // measured under 20ms in model-roster.test.mjs, so no mtime guard is needed.
    if (!rosterRefreshInFlight) {
      rosterRefreshInFlight = true;
      Promise.resolve().then(() => _refreshRoster({ env: rosterEnv, config: cfg, registry: rosterRegistry }))
        .catch(() => {})
        .finally(() => { rosterRefreshInFlight = false; });
    }
    if (!priceRefreshInFlight) {
      priceRefreshInFlight = true;
      Promise.resolve().then(() => _refreshPrices({ path: rateCardPath, rosterIds: roster, enabled: enabledProviders, out: log, err: log }))
        .catch(() => {})
        .finally(() => { priceRefreshInFlight = false; });
    }
    const cards = rateCards(rateCardPath);
    return costProvidersFor(enabledProviders).flatMap((provider) =>
      costRowsFor(provider, { models: roster[provider] || [], snaps: costCache.snaps, cards }));
  };
  const rankOf = (cells, model) => {
    const ranked = rankCells(cells, { cloudSuffix }).filter((c) => c.combined != null && !c.supersededBy);
    const i = ranked.findIndex((c) => c.model === model);
    return i < 0 ? null : { position: i + 1, of: ranked.length };
  };
  // The cloud suffix is shared by Cost and Performance.
  const cloudSuffix = providerConfig(cfg, "ollama")?.cloudSuffix || ":cloud";
  const costOf = (rows, domain) => {
    const ollama = providerConfig(cfg, "ollama");
    return costView(rows, costRows(), {
      domain,
      bands: resolveBands(ollama?.cloud?.ollama?.costBands),
      valueMargin: ollama?.cloud?.ollama?.valueMargin,
      cloudSuffix,
    });
  };
  const perf = (res, url) => {
    const q = (k) => url.searchParams.get(k) || undefined;
    const aspect = q("aspect"), model = q("model"), domain = q("domain");
    if (aspect && !ASPECTS.includes(aspect)) return send(res, 400, { error: `unknown aspect ${aspect}`, aspects: ASPECTS });
    if (!grading) return send(res, 200, { grading, path: scoresFile }); // off means off: nothing ranked, nothing listed
    const rows = scoreRows();
    const live = dedupe(rows);
    const domains = [...new Set(live.map((r) => r.domain).filter(Boolean))].sort();
    const report = aggregate(rows, { aspect, model, domain, combineProviders: true });
    const cost = costOf(rows, domain);
    send(res, 200, {
      grading, path: scoresFile, lines: rows.length, rows: live.length, priorWeight: PRIOR_WEIGHT,
      aspects: ASPECTS, universals: UNIVERSAL, domains,
      filters: report.filters,
      overall: rankCells(overall(rows, { model, domain, combineProviders: true }).cells, { cloudSuffix, view: cost }),
      // Drill-in: where this model sits among the models the ranking draws, not every graded one.
      ...(model ? { rank: rankOf(overall(rows, { domain, combineProviders: true }).cells, model) } : {}),
      report: report.aspects,
      views: {
        coverage: coverage(report), reliability: reliability(live), leaders: leaders(report),
        cost,
      },
    });
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (dash.token && url.searchParams.get("t") !== dash.token) return send(res, 401, { error: "token" });
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    const p = url.pathname;

    if (p === "/") {
      if (!existsSync(PAGE)) return send(res, 500, "page.html missing", "text/plain");
      return send(res, 200, pageHtml(), "text/html; charset=utf-8");
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
      req.on("close", () => drop(res));
      res.on("error", () => drop(res));
      return;
    }
    const jsAsset = JS_ASSETS[p];
    if (jsAsset) {
      if (!existsSync(jsAsset)) return notFound(res);
      return send(res, 200, readFileSync(jsAsset, "utf8"), "text/javascript; charset=utf-8");
    }
    if (p === "/logos.js") return send(res, 200, logosScript(), "text/javascript; charset=utf-8");
    if (p === "/api/perf") return perf(res, url);
    // Grading-independent: prices exist without grades, so only the value verdicts need the store.
    if (p === "/api/cost") return send(res, 200, { ...costOf(grading ? scoreRows() : []), grading });
    // A live read of every provider: swarm.mjs injects it, since importing swarm.mjs here deadlocks on its top-level await.
    if (p === "/api/usage") {
      if (!_readProviderUsage) throw new Error("no _readProviderUsage seam wired");
      // `live` says the adapters MAY fetch; it is no longer a demand that they
      // do. The reading comes through the same 5-minute cache every other
      // reader uses, so a repaint costs a provider process only when it is due.
      return send(res, 200, await _readProviderUsage(cfg, { live: true }));
    }
    if (routes[p]) return await routes[p](res, url);

    // A trailing slash is what the URL parser leaves behind after collapsing an
    // encoded dot-segment (%2e%2e) — never a resource, so never served.
    if (!p.startsWith("/api/runs/") || p.endsWith("/")) return notFound(res);
    const seg = decodeSegments(p.slice("/api/runs/".length));
    if (!seg || seg.length < 2) return notFound(res);
    const dir = runDir(seg[0], seg[1]);
    if (!dir) return notFound(res);

    if (seg.length === 2) {
      const run = readRun(dir, { now: now(), quietWarnMs, heartbeatMs });
      if (!run) return notFound(res);
      // The deep-linked header needs the short project name: the same grouping rule
      // the runs list caps by, over the same full raw key set.
      // projectKeys, never listRuns: the label needs the raw key SET, and a full
      // estate scan here ran on every run/node/leaf fetch including the 5 s poll.
      const { groupOf, labelOf } = projectGrouping(_projectKeys(home));
      return send(res, 200, { ...run, groupLabel: labelOf(groupOf(run.project)) });
    }
    // Already HTML — served as written, never through mdToHtml. 20 runs on disk
    // carry one and nothing could reach them before this route existed.
    if (seg.length === 3 && seg[2] === "report") {
      const file = join(dir, "report.html");
      if (!existsSync(file)) return notFound(res);
      return send(res, 200, readFileSync(file, "utf8"), "text/html; charset=utf-8");
    }
    if (seg.length === 3 && seg[2] === "digest") {
      const md = ["report.md", "digest.md"].map((f) => join(dir, f)).find(existsSync);
      if (!md) return notFound(res);
      return send(res, 200, mdToHtml(readFileSync(md, "utf8"), { title: `${seg[1]} · digest` }), "text/html; charset=utf-8");
    }
    if (seg.length === 4 && seg[2] === "leaves") {
      const file = resolve(dir, "results", `${seg[3]}.json`);
      if (!file.startsWith(dir + sep)) return notFound(res);
      // A result file appears when a leaf finishes — and STAYS when the run is resumed,
      // so its presence says nothing about the attempt now running. Ask the engine
      // instead: readRun's state is per-attempt (readRunLog clears on every run-start),
      // and a leaf that has not settled in this attempt did not write what is on disk.
      // Both cases serve the manifest's authored prompt, which is what you want to see
      // mid-run anyway. Flagged `authored` because {{result:…}} placeholders are
      // substituted at dispatch, not in the snapshot.
      const leafState = readRun(dir, { now: now(), quietWarnMs, heartbeatMs })?.tasks
        .find((t) => t.id === seg[3])?.state;
      if (!existsSync(file) || resultSuperseded(leafState)) {
        const prompt = authoredPrompt(dir, seg[3]);
        return prompt ? send(res, 200, { id: seg[3], prompt, authored: true }) : notFound(res);
      }
      let r;
      try { r = JSON.parse(readFileSync(file, "utf8")); } catch { return notFound(res); }
      // `prompt` is exposed deliberately — the leaf view renders it as a collapsed
      // accordion, and it is the one field that says what the leaf was actually asked.
      const { id, provider, runner, model, ok, exit, durationMs, tokens, costUsd, numTurns, prompt, output, outputJson, citations, worktree, cwd, coverage } = r;
      return send(res, 200, { id, provider, runner, model, ok, exit, durationMs, tokens, costUsd, numTurns, prompt, output, outputJson, citations, worktree, cwd, coverage });
    }
    return notFound(res);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log(`${req.url}: ${e.message}`); try { send(res, 500, { error: "internal" }); } catch {} });
  });
  server.on("close", () => { stopHub(); estate.close(); });
  // A handover retake re-listens on this server after `close` — re-arm the estate.
  server.on("listening", () => estate.reopen?.());
  return server;
}
