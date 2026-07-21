import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, writeFile, unlink, constants } from "node:fs/promises";
import { join } from "node:path";
import { loadExtensions } from "../extensions/loader.mjs";

const execFileAsync = promisify(execFile);

/**
 * @typedef {{ name: string, ok: boolean, detail: string }} Check
 */

/**
 * Run all doctor checks and return results.
 *
 * @param {{ config: object, paths: object, web: object, log: object }} opts
 * @returns {Promise<Check[]>}
 */
export async function runDoctor({ config, paths, web, log }) {
  const checks = [];

  const check = (name, fn) =>
    fn()
      .then(detail => { checks.push({ name, ok: true, detail: detail ?? "ok" }); })
      .catch(e  => { checks.push({ name, ok: false, detail: e.message }); });

  await check("Node version (≥22)", async () => {
    const major = parseInt(process.versions.node.split(".")[0], 10);
    if (major < 22) throw new Error(`Node ${process.versions.node} — need ≥22`);
    return process.versions.node;
  });

  await check("claude CLI on PATH", async () => {
    const cwd = config.claude?.cwd ?? process.cwd();
    const { stdout } = await execFileAsync("claude", ["--version"], { cwd, timeout: 10_000 });
    return stdout.trim().split("\n")[0];
  });

  await check("Config file schema valid", async () => {
    if (!config.tokens?.bot) throw new Error("tokens.bot is missing");
    if (!config.tokens?.app) throw new Error("tokens.app is missing");
    if (!config.claude?.cwd) throw new Error("claude.cwd is missing");
    return "required fields present";
  });

  await check("Bot token (auth.test)", async () => {
    const info = await web.authTest();
    return `${info.user} in ${info.team}`;
  });

  await check("App token (apps.connections.open)", async () => {
    const info = await web.appsConnectionsOpen();
    // We only validate the response; don't actually open the WS
    if (!info.url) throw new Error("no WSS URL returned");
    return "WSS URL ok";
  });

  await check("Session store writable", async () => {
    const p = paths.sessionsFile ?? join(paths.dataDir, "sessions.json");
    const tmp = p + ".doctor-tmp";
    await writeFile(tmp, "{}");
    await unlink(tmp);
    return p;
  });

  await check("Log dir writable", async () => {
    await access(paths.logDir, constants.W_OK);
    return paths.logDir;
  });

  if (Array.isArray(config.extensions) && config.extensions.length > 0) {
    await check("Extensions load + selfCheck", async () => {
      const noop = { info() {}, warn() {}, child() { return noop; } };
      const exts = await loadExtensions({ paths: config.extensions, log: noop });
      const names = exts.list();
      if (!names.length) throw new Error("no extensions loaded successfully");
      return names.join(", ");
    });
  } else {
    checks.push({ name: "Extensions", ok: true, detail: "none configured" });
  }

  await check("Autostart entry", async () => {
    return await checkAutostart();
  });

  await check("Daemon status", async () => {
    return await checkDaemonStatus();
  });

  // Remote-control subsystem checks (only when a control token is configured).
  if (config.remote?.controlToken) {
    await check("Remote-control broker", async () => {
      const port = config.remote.brokerPort ?? 7898;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`broker on ${port} not healthy`);
        const body = await res.json();
        return `healthy on ${port} (${body.peers} peer(s))`;
      } catch {
        return `not reachable on ${port} — a live session's MCP server will self-start it`;
      }
    });

    await check("Remote-control endpoint", async () => {
      const port = config.remote.controlPort ?? 7897;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${config.remote.controlToken}` },
          signal: AbortSignal.timeout(2000),
        });
        if (res.status === 401) throw new Error("token mismatch — controlToken differs from the running daemon");
        if (!res.ok) throw new Error(`endpoint on ${port} returned ${res.status}`);
        return `healthy on ${port}`;
      } catch (e) {
        throw new Error(`not reachable on ${port} (is the bridge running?) — ${e.message}`);
      }
    });

    checks.push({
      name: "Remote-control scopes",
      ok: !!config.remote.createChannels,
      detail: config.remote.createChannels
        ? "channels:write/manage configured — /slack-remote creates #rc-<context>"
        : "DM-seize default (no channels:write/manage) — /slack-remote seizes an existing DM",
    });
  } else {
    checks.push({ name: "Remote control", ok: true, detail: "disabled (no remote.controlToken)" });
  }

  return checks;
}

async function checkAutostart() {
  const platform = process.platform;
  if (platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "schtasks",
        ["/Query", "/TN", "ClaudeSlackBridge", "/FO", "LIST"],
        { timeout: 5_000 },
      );
      return stdout.includes("ClaudeSlackBridge") ? "registered" : "not registered";
    } catch {
      return "not registered";
    }
  }
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "launchctl",
        ["list", "com.claudeslack.bridge"],
        { timeout: 5_000 },
      );
      return stdout.trim() ? "registered" : "not registered";
    } catch {
      return "not registered";
    }
  }
  if (platform === "linux") {
    try {
      await execFileAsync(
        "systemctl",
        ["--user", "is-enabled", "claude-slack"],
        { timeout: 5_000 },
      );
      return "enabled";
    } catch {
      return "not registered";
    }
  }
  return `unknown platform: ${platform}`;
}

async function checkDaemonStatus() {
  // Check for a running process named node running claude-slack
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-Command",
          "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*claude-slack*' } | Select-Object -ExpandProperty ProcessId"],
        { timeout: 5_000 },
      );
      const pid = stdout.trim();
      return pid ? `running (PID ${pid})` : "not running";
    }
    const { stdout } = await execFileAsync(
      "pgrep",
      ["-f", "claude-slack"],
      { timeout: 5_000 },
    );
    const pids = stdout.trim().split("\n").filter(Boolean);
    return pids.length ? `running (PID ${pids.join(", ")})` : "not running";
  } catch {
    return "not running";
  }
}

/** Print doctor results as a human-readable checklist. */
export function printDoctor(checks, { json = false } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(checks, null, 2) + "\n");
    return;
  }
  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    process.stdout.write(`${icon} ${c.name}: ${c.detail}\n`);
  }
  const failed = checks.filter(c => !c.ok);
  if (failed.length) {
    process.stdout.write(`\n${failed.length} check(s) failed.\n`);
  } else {
    process.stdout.write("\nAll checks passed.\n");
  }
}
