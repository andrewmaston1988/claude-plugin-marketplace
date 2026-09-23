// `swarm serve` — the dashboard daemon: start/stop/status/restart, autostart
// install, the tray, and doctor. Split out of swarm.mjs, which now just
// dispatches to it. Every serve-side module is imported lazily, so the other
// subcommands never pay for loading the server.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { swarmHome, getConfig } from "../src/config.mjs";
import { dim, out, err } from "../src/ui.mjs";

// serve — the LAN dashboard. Foreground by default; --daemon forks a detached
// copy and records its pid (written by the parent, per the plugin daemon rule).
export async function cmdServe(rest, { readProviderUsage }) {
  const { writePid, readPid, clearPid, isAlive, urlLines, firewallHint, installAutostart, uninstallAutostart, defaultStartupDir,
    resolveInstalled, isStale, blocksStart, bindFailureRecordAction, waitForDaemon, statusReport, registryPath, ensureShim, probePort, waitForExit, restartPlan, drainAndClose, spawnLoggedDaemon } = await import("../src/serve/daemon.mjs");
  const { launchTray } = await import("../src/serve/tray.mjs");
  const { runDoctor } = await import("../src/serve/doctor.mjs");
  const home = swarmHome();
  const cfg = getConfig();
  const port = cfg.dashboard?.port ?? 7331;
  // The CLI entry point beside this file, never this file — a respawned daemon
  // has to come up through the dispatcher, which is the only module with a main().
  const enginePath = fileURLToPath(new URL("./swarm.mjs", import.meta.url));
  const verb = rest[0] && !rest[0].startsWith("--") ? rest[0] : "start";
  const exitSoon = (code) => { setTimeout(() => process.exit(code), 150); };
  const installed = resolveInstalled({ registry: registryPath() });
  // The stable shim every restart/re-exec goes through — never this file, which
  // sits in the sha-versioned plugin cache and moves on every update.
  const shimPath = join(home, "serve.mjs");

  if (verb === "stop") {
    const rec = readPid(home);
    const pid = rec?.pid;
    if (!pid || !isAlive(pid)) { out("dashboard: not running"); clearPid(home); exitSoon(0); return 0; }
    try { process.kill(pid); } catch (e) { err(`dashboard: could not stop pid ${pid}: ${e.message}`); exitSoon(1); return 1; }
    clearPid(home);
    out(`dashboard: stopped pid ${pid}`);
    exitSoon(0); return 0;
  }
  if (verb === "status") {
    const rec = readPid(home);
    const alive = isAlive(rec?.pid);
    const rep = statusReport({ record: rec, alive, installed, port, urls: alive ? urlLines(port) : [], startupDir: defaultStartupDir(), shimPath });
    for (const line of rep.lines) out(line);
    exitSoon(rep.exit); return rep.exit;
  }
  if (verb === "doctor") {
    const code = await runDoctor({ home, installed, port, cfg, shimPath, out });
    exitSoon(code); return code;
  }
  if (verb === "install-autostart" || verb === "uninstall-autostart") {
    const startupDir = defaultStartupDir();
    // Point the launcher at the resolver shim on a stable path, never at this
    // file: enginePath is inside the sha-versioned plugin cache and moves on
    // every update.
    const shim = ensureShim({ home, resolverSrc: fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)) });
    const r = verb === "install-autostart"
      ? installAutostart({ startupDir, nodePath: process.execPath, enginePath: shim, engineArgs: ["scripts/swarm.mjs", "serve", "--daemon"] })
      : uninstallAutostart({ startupDir });
    if (!startupDir) out(`no Startup folder on this platform — add "${process.execPath}" "${shim}" scripts/swarm.mjs serve --daemon to your login items by hand`);
    else out(verb === "install-autostart" ? `autostart: ${r.changed ? "installed" : "already installed"} → ${r.path}` : `autostart: ${r.removed ? "removed" : "was not installed"}`);
    exitSoon(0); return 0;
  }
  // enable/disable write the key and NOTHING else: no daemon, no tray. The two
  // callers that need a side effect — setup's dashboard stage and the tray's own
  // menu — each ask the operator and then run `serve` or `serve stop`, so the
  // answer stays observable on its own and neither caller inherits a surprise.
  if (verb === "enable" || verb === "disable") {
    const want = verb === "enable";
    const { setConfigValue } = await import("../src/config.mjs");
    let r;
    try { r = setConfigValue("dashboard.enabled", want, process.env.SWARM_CONFIG); }
    catch (e) { err(`dashboard: ${e.message}`); return 1; }
    out(`dashboard: ${want ? "enabled" : "disabled"} (${r.key}=${want} in ${r.path})`);
    out(want ? "  start it with: swarm serve" : "  a running dashboard keeps serving until: swarm serve stop");
    return 0;
  }
  if (verb !== "start" && verb !== "restart") { err(USAGE); return 1; }

  // The off switch — covers restart too, which would stop the daemon and start
  // nothing. stop/status/doctor/autostart verbs still work above, so a Startup
  // launcher left installed becomes a no-op instead of needing uninstalling.
  if (cfg.dashboard?.enabled === false) {
    out("dashboard: disabled (dashboard.enabled=false in ~/.swarm/config.json)");
    const t = await launchTray({ home, port, shimPath, tray: cfg.dashboard?.tray !== false, disabled: true });
    if (!t.ok) err(`dashboard: ${t.reason}`);
    exitSoon(0); return 0;
  }

  // The --daemon parent records the child's pid before the child gets here, so a
  // pid equal to our own is us, not a rival. A live daemon with a moved-off
  // version does NOT block start — starting is then a takeover of it.
  const running = readPid(home);
  const aliveRunning = isAlive(running?.pid);
  const takeover = Boolean(running?.pid && running.pid !== process.pid && aliveRunning && isStale(running, installed));
  // restart never short-circuits here — even a live, current-version daemon must
  // go through the kill -> waitForExit -> startDetached path below; that short
  // circuit exists for `start` only.
  if (verb !== "restart" && blocksStart(running, installed, process.pid, aliveRunning)) {
    out(`dashboard: already running (pid ${running.pid})`);
    for (const u of urlLines(port)) out(`  ${u}`);
    exitSoon(0); return 0;
  }
  if (takeover) out(`dashboard: taking over from stale pid ${running.pid} (running ${running.version} → installed ${installed?.version})`);

  // The detached spawn shared by --daemon and restart. On a takeover the parent
  // must NOT write the pid record: the live old daemon still owns it, and the
  // child hands it back if it loses the bind. In the normal case the parent
  // writes pre-fork so a second `serve --daemon` sees the child and short-circuits.
  const startDetached = async () => {
    ensureShim({ home, resolverSrc: fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)) });
    // The same recipe `update-watch.mjs`'s replacement spawn uses (daemon.mjs's
    // spawnLoggedDaemon): raw stdio (crash stacks) to dashboard-stdio.log,
    // separate from dashboard.log, which the daemon owns as a structured,
    // rotated event log.
    const started = spawnLoggedDaemon([process.execPath, enginePath, "serve"], home);
    if (!started.ok) return { ok: false, reason: `could not spawn the daemon: ${started.reason}` };
    if (!takeover) writePid(home, { pid: started.pid, port, installPath: installed?.installPath ?? null, version: installed?.version ?? null, startedMs: Date.now() });
    const t = await launchTray({ home, port, shimPath, tray: cfg.dashboard?.tray !== false });
    if (!t.ok) err(`dashboard: ${t.reason}`);
    return { ok: true, pid: started.pid, logPath: started.logPath };
  };

  if (verb === "restart") {
    const rec = readPid(home);
    const pid = rec?.pid;
    const wasAlive = Boolean(pid && isAlive(pid));
    // Wait for the signalled daemon to ACTUALLY exit before starting anything.
    // Starting while it still holds the port loses the bind, and clearing its
    // record while it is alive leaves a daemon `serve stop` can never reach.
    let exited = true;
    if (wasAlive) {
      try { process.kill(pid); } catch (e) { err(`dashboard: could not stop pid ${pid}: ${e.message}`); exitSoon(1); return 1; }
      ({ exited } = await waitForExit(pid, { isAlive }));
    }
    const plan = restartPlan({ record: rec, wasAlive, exited });
    if (plan.act === "abort") {
      err(`dashboard: restart aborted — ${plan.reason} (pid ${pid}); nothing was stopped or started`);
      exitSoon(1); return 1;
    }
    if (wasAlive) out(`dashboard: stopped pid ${pid}`);
    else out("dashboard: not running — starting");
    if (plan.clearRecord) clearPid(home);
    const started = await startDetached();
    if (!started.ok) { err(`dashboard: ${started.reason}`); exitSoon(1); return 1; }
    // excludePid is null here, not the old pid: we waited for that process to exit
    // and cleared its record, so any record now is the replacement. Excluding it
    // meant an OS pid reuse reported a failed restart while the dashboard was up.
    const w = await waitForDaemon({ read: () => readPid(home), isAlive, excludePid: null, deadlineMs: 15000 });
    if (!w.ok) { err(`dashboard: restart failed — ${w.reason}`); exitSoon(1); return 1; }
    out(`dashboard: restarted pid ${w.record.pid} (version ${w.record.version ?? "unknown"})`);
    for (const u of urlLines(port)) out(`  ${u}`);
    exitSoon(0); return 0;
  }

  if (rest.includes("--daemon")) {
    const started = await startDetached();
    if (!started.ok) { err(`dashboard: ${started.reason}`); exitSoon(1); return 1; }
    out(`dashboard: started pid ${started.pid} (events: ${join(home, "dashboard.log")}, stdio: ${started.logPath})`);
    for (const u of urlLines(port)) out(`  ${u}`);
    out(dim(`firewall (once, elevated): ${firewallHint(port)}`));
    exitSoon(0); return 0;
  }

  const { createServer } = await import("../src/serve/server.mjs");
  const { createLogger } = await import("../src/serve/log.mjs");
  const { startUpdateWatch } = await import("../src/serve/update-watch.mjs");
  ensureShim({ home, resolverSrc: fileURLToPath(new URL("../statusline/resolver.mjs", import.meta.url)) });
  const dlog = createLogger({ logDir: home }).log;
  // Registered before ANYTHING else in this branch — including the pre-listen
  // pid write and listenOnce/bindFailureRecordAction below — so a crash in the
  // bind/takeover window (exactly where an update-watch replacement runs) is
  // logged too, not just one after serving starts (amended after dash-ar-1).
  // No pid clear: that is how the tray tells a crash from a deliberate `serve
  // stop`, which does clear it.
  const crash = (e) => {
    dlog("crash", { msg: String(e?.message ?? e), stack: e?.stack });
    setTimeout(() => process.exit(1), 150);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  // Test-only crash triggers, armed only under `node --test` (NODE_TEST_CONTEXT), so
  // a stray exported variable can never crash-loop a real daemon. They exercise the
  // REGISTERED handlers above, never call `crash` directly.
  if (process.env.NODE_TEST_CONTEXT && process.env.SWARM_SERVE_TEST_CRASH === "before-listen") {
    process.nextTick(() => { throw new Error("SWARM_SERVE_TEST_CRASH=before-listen"); });
  }
  const server = createServer({ home, cfg, log: (m) => err(`dashboard: ${m}`), _readProviderUsage: readProviderUsage });
  const bind = cfg.dashboard?.bind ?? "0.0.0.0";
  // SSE streams never "finish", so they cannot count as in-flight for the
  // handover drain — they are ended outright at handover and the browser
  // reconnects to the replacement. Tracked from before the first listen so a
  // handover never misses a stream.
  const sockets = new Set();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  const sse = new Set();
  server.on("request", (req, res) => {
    if ((req.headers.accept || "").includes("text/event-stream")) {
      sse.add(res);
      res.on("close", () => sse.delete(res));
    }
  });
  const listenOnce = () => new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once("error", onErr);
    server.listen(port, bind, () => { server.removeListener("error", onErr); resolve(); });
  });
  const record = { pid: process.pid, port, installPath: installed?.installPath ?? null, version: installed?.version ?? null, startedMs: Date.now() };
  const prevRecord = readPid(home); // a live stale daemon we are taking over from, if any
  writePid(home, record); // before listen, per the daemon lifecycle rule; handed back below if listen fails
  try {
    await listenOnce();
  } catch (e) {
    // A failed bind must not strand a live rival recordless — `serve stop` could
    // then never reach it. Hand the record back; clear only what was ours.
    const act = bindFailureRecordAction({ current: readPid(home), prevRecord, ownPid: process.pid, alive: isAlive });
    if (act.act === "restore") writePid(home, act.record);
    else if (act.act === "clear") clearPid(home);
    throw e;
  }
  writePid(home, { ...record, listening: true }); // the restart/handover protocol reads this
  if (process.env.NODE_TEST_CONTEXT && process.env.SWARM_SERVE_TEST_CRASH === "after-listen") {
    setTimeout(() => { throw new Error("SWARM_SERVE_TEST_CRASH=after-listen"); }, 20);
  }
  out(`dashboard: serving ~/.swarm/runs on port ${port}`);
  for (const u of urlLines(port)) out(`  ${u}`);
  out(dim(`firewall (once, elevated): ${firewallHint(port)}`));

  // Handover plumbing for the update watcher: release the port for the
  // replacement, retake it when the replacement fails. Plain requests drain
  // first; anything still holding the port after the grace window is cut.
  const exitDaemon = (code) => { setTimeout(() => process.exit(code), 150); };
  const prepare = async () => {
    for (const res of sse) { try { res.end(); } catch {} }
    sse.clear();
    await drainAndClose({
      close: (cb) => server.close(cb),
      destroySockets: () => { for (const s of sockets) { try { s.destroy(); } catch {} } },
    });
  };
  const retake = async () => {
    try {
      await listenOnce();
    } catch (e) {
      // Someone else holds the port. A live daemon on the record, or anything
      // reachable there, is the dashboard being served — bow out. Only a dead
      // port we cannot retake is a wedge, and a record still naming us must
      // not linger pointing at a pid that gave up.
      const cur = readPid(home);
      if (cur?.pid && cur.pid !== process.pid && isAlive(cur.pid)) { exitDaemon(0); return; }
      const p = await probePort(port, bind);
      if (p.reachable) { exitDaemon(0); return; }
      if (cur?.pid === process.pid) clearPid(home);
      exitDaemon(1);
      return;
    }
    writePid(home, { ...record, listening: true });
  };
  dlog("serve", { msg: `listening on ${bind}:${port}`, pid: record.pid, version: record.version });
  startUpdateWatch({
    registryPath: registryPath(), own: record, shimPath, home,
    autoRestart: cfg.dashboard?.autoRestartOnUpdate !== false,
    prepare, retake,
    log: (msg) => dlog("update-watch", { msg }),
  });
  const stop = () => { const cur = readPid(home); if (cur?.pid === process.pid) clearPid(home); server.close(); setTimeout(() => process.exit(0), 150); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {}); // serve until signalled
  return 0;
}

