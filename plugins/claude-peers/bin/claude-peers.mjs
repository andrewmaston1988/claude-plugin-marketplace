#!/usr/bin/env node
// claude-peers CLI: `mcp` (stdio MCP server, what the plugin manifest wires),
// `broker start|run|stop|status`, `doctor`.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

// state + pid are port-scoped: two brokers (e.g. a test broker on 7999 beside
// the real one) must never share state or clobber each other's pid file.
function getDefaultPaths(paths, port) {
  return {
    ...paths,
    configFile: path.join(paths.configDir, "config.json"),
    stateFile: path.join(paths.stateDir, `peers-state-${port}.json`),
    pidFile: path.join(paths.stateDir, `claude-peers-broker-${port}.pid`),
  };
}

function _writePid(pidFile, pid) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const tmp = pidFile + ".tmp";
  fs.writeFileSync(tmp, String(pid));
  fs.renameSync(tmp, pidFile);
}

function _readPid(pidFile) {
  try {
    return parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10) || null;
  } catch {
    return null;
  }
}

function _clearPid(pidFile) {
  try { fs.unlinkSync(pidFile); } catch {}
}

function _isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

(async () => {
  const { getPaths } = await import("../src/paths.mjs");
  const { loadConfig } = await import("../src/config.mjs");
  const basePaths = getPaths();
  const config = loadConfig({ paths: basePaths });
  const paths = getDefaultPaths(basePaths, config.port);

  if (cmd === "mcp") {
    const { createPeersServer } = await import("../src/mcp/server.mjs");
    const { createLogger } = await import("../src/log.mjs");
    const server = createPeersServer({ config, log: createLogger("claude-peers") });
    await server.start();
    return; // stays alive on stdin + timers
  }

  if (cmd === "broker" && sub === "run") {
    const { createBroker } = await import("../src/broker/index.mjs");
    const { createLogger } = await import("../src/log.mjs");
    const log = createLogger("claude-peers broker");
    let shutdown; // assigned below; /shutdown reaches it via onShutdown
    const broker = createBroker({ stateFile: paths.stateFile, log, onShutdown: () => shutdown() });
    try {
      await broker.listen(config.port);
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        log(`port ${config.port} already in use — another broker is running`);
        setTimeout(() => process.exit(0), 150);
        return;
      }
      throw e;
    }
    _writePid(paths.pidFile, process.pid);
    const reapTimer = setInterval(() => broker.reapDead(), 30_000);
    shutdown = () => {
      clearInterval(reapTimer);
      _clearPid(paths.pidFile);
      broker.close().then(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    log(`listening on 127.0.0.1:${config.port} (state: ${paths.stateFile})`);
    return;
  }

  if (cmd === "broker" && sub === "start") {
    if (await health(config.port)) {
      process.stdout.write(`broker already running on port ${config.port}\n`);
      setTimeout(() => process.exit(0), 150);
      return;
    }
    const child = spawn(process.execPath, [path.join(HERE, "claude-peers.mjs"), "broker", "run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await health(config.port)) {
        process.stdout.write(`broker started on port ${config.port} (pid ${child.pid})\n`);
        setTimeout(() => process.exit(0), 150);
        return;
      }
    }
    process.stderr.write("broker failed to come up within 6s\n");
    setTimeout(() => process.exit(1), 150);
    return;
  }

  if (cmd === "broker" && sub === "stop") {
    // stop via the broker's own /shutdown — never a pid-based kill, which can
    // hit an unrelated process that reused a stale pid.
    if (!(await health(config.port))) {
      _clearPid(paths.pidFile);
      process.stdout.write(`broker not running on port ${config.port} (stale pid cleared)\n`);
      setTimeout(() => process.exit(0), 150);
      return;
    }
    try {
      await fetch(`http://127.0.0.1:${config.port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) });
    } catch {}
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (!(await health(config.port, 500))) {
        process.stdout.write(`broker on port ${config.port} stopped\n`);
        setTimeout(() => process.exit(0), 150);
        return;
      }
    }
    process.stderr.write(`broker on port ${config.port} did not stop within 3s\n`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  if (cmd === "broker" && sub === "status") {
    const h = await health(config.port);
    const pid = _readPid(paths.pidFile);
    if (h) process.stdout.write(`running on port ${config.port} — ${h.peers} peer(s)${pid ? ` (pid ${pid})` : ""}\n`);
    else process.stdout.write(`not running on port ${config.port}\n`);
    setTimeout(() => process.exit(h ? 0 : 1), 150);
    return;
  }

  if (cmd === "doctor") {
    const checks = [];
    const major = parseInt(process.versions.node.split(".")[0], 10);
    checks.push([major >= 20, `node ${process.versions.node} (need >= 20)`]);
    checks.push([true, `config: port ${config.port}, poll ${config.pollIntervalMs}ms (from ${fs.existsSync(paths.configFile) ? paths.configFile : "defaults"})`]);
    const h = await health(config.port);
    checks.push([Boolean(h), h ? `broker healthy on ${config.port} (${h.peers} peers)` : `broker not reachable on ${config.port} — a session's mcp subcommand will auto-start it`]);
    try {
      const { loadState } = await import("../src/broker/store.mjs");
      loadState(paths.stateFile);
      checks.push([true, `state file ok: ${paths.stateFile}`]);
    } catch (e) {
      checks.push([false, `state file problem: ${e.message}`]);
    }
    const pid = _readPid(paths.pidFile);
    if (pid) checks.push([_isAlive(pid), `pid file ${pid} ${_isAlive(pid) ? "alive" : "stale"}`]);
    let failed = 0;
    for (const [ok, msg] of checks) {
      if (!ok) failed++;
      process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${msg}\n`);
    }
    setTimeout(() => process.exit(failed ? 1 : 0), 150);
    return;
  }

  process.stderr.write(
    "usage: claude-peers <command>\n" +
    "  mcp                       run the stdio MCP server (used by the plugin manifest)\n" +
    "  broker start|stop|status  manage the shared broker daemon\n" +
    "  broker run                run the broker in the foreground\n" +
    "  doctor                    check node, config, broker health, state file\n"
  );
  setTimeout(() => process.exit(2), 150);
})().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  setTimeout(() => process.exit(1), 150);
});
