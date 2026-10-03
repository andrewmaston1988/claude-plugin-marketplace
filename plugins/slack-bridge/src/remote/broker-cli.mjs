import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config.mjs";

// Broker subcommands hold a pid FILE (port-scoped), not the paths object.
function _writePidFile(file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(process.pid));
}
function _readPidFile(file) {
  if (!existsSync(file)) return null;
  return parseInt(readFileSync(file, "utf8").trim(), 10) || null;
}
function _clearPidFile(file) { try { unlinkSync(file); } catch {} }

// Port-scoped broker pid files (a test broker must not clobber the real one).
function _brokerPidFile(paths, port) { return join(paths.stateDir, `remote-broker-${port}.pid`); }
function _brokerStateFile(paths, port) { return join(paths.stateDir, `remote-broker-state-${port}.json`); }
async function _brokerHealth(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// `claude-slack broker <start|stop|status|run>`. `entry` is the bin path, re-spawned for `start`.
export async function runBrokerCommand({ rest, paths, entry, getFlag }) {
  const configArg = getFlag("--config", rest) ?? paths.configFile;
  let brokerPort;
  let brokerToken = null;
  try {
    const c = await loadConfig({ configPath: configArg });
    brokerPort = c.remote?.brokerPort ?? 7898;
    brokerToken = c.remote?.controlToken ?? null;
  } catch { brokerPort = 7898; }
  const portOverride = getFlag("--port", rest);
  if (portOverride) brokerPort = parseInt(portOverride, 10);
  const pidFile = _brokerPidFile(paths, brokerPort);
  const stateFile = _brokerStateFile(paths, brokerPort);
  const sub = rest[0];

  if (sub === "run") {
    const { createBroker } = await import("./broker.mjs");
    const { createLogger } = await import("../log.mjs");
    const log = createLogger({ logDir: paths.logDir, tag: "remote-broker" });
    // createBroker calls log(msg, extra) as a plain function, not a logger object.
    const brokerLog = (msg, extra) => log.info(msg, extra);
    let shutdown;
    const broker = createBroker({ stateFile, log: brokerLog, token: brokerToken, onShutdown: () => shutdown() });
    try { await broker.listen(brokerPort); }
    catch (e) {
      if (e.code === "EADDRINUSE") { brokerLog(`port ${brokerPort} already in use — another broker is running`); setTimeout(() => process.exit(0), 150); return; }
      throw e;
    }
    _writePidFile(pidFile);
    const reapTimer = setInterval(() => broker.reapDead(), 30_000);
    shutdown = () => { clearInterval(reapTimer); _clearPidFile(pidFile); broker.close().then(() => process.exit(0)); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    log.info(`remote-control broker listening on 127.0.0.1:${brokerPort} (state: ${stateFile})`);
    return;
  }

  if (sub === "start") {
    if (await _brokerHealth(brokerPort)) { process.stdout.write(`broker already running on port ${brokerPort}\n`); setTimeout(() => process.exit(0), 150); return; }
    const child = spawn(process.execPath, [entry, "broker", "run", "--port", String(brokerPort), "--config", configArg], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await _brokerHealth(brokerPort)) { process.stdout.write(`broker started on port ${brokerPort} (pid ${child.pid})\n`); setTimeout(() => process.exit(0), 150); return; }
    }
    process.stderr.write("broker failed to come up within 6s\n");
    setTimeout(() => process.exit(1), 150);
    return;
  }

  if (sub === "stop") {
    if (!(await _brokerHealth(brokerPort))) { _clearPidFile(pidFile); process.stdout.write(`broker not running on port ${brokerPort} (stale pid cleared)\n`); setTimeout(() => process.exit(0), 150); return; }
    try {
      await fetch(`http://127.0.0.1:${brokerPort}/shutdown`, {
        method: "POST",
        headers: brokerToken ? { Authorization: `Bearer ${brokerToken}` } : {},
        signal: AbortSignal.timeout(2000),
      });
    } catch {}
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (!(await _brokerHealth(brokerPort, 500))) { process.stdout.write(`broker on port ${brokerPort} stopped\n`); setTimeout(() => process.exit(0), 150); return; }
    }
    process.stderr.write(`broker on port ${brokerPort} did not stop within 3s\n`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  if (sub === "status") {
    const h = await _brokerHealth(brokerPort);
    const pid = _readPidFile(pidFile);
    if (h) process.stdout.write(`running on port ${brokerPort} — ${h.peers} peer(s)${pid ? ` (pid ${pid})` : ""}\n`);
    else process.stdout.write(`not running on port ${brokerPort}\n`);
    setTimeout(() => process.exit(h ? 0 : 1), 150);
    return;
  }

  process.stderr.write("usage: claude-slack broker <start|stop|status|run> [--port P]\n");
  setTimeout(() => process.exit(2), 150);
}
