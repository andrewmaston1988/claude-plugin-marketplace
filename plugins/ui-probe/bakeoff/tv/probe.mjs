// RQ6 — the Tizen TV probe, run exactly as the plan states it:
//
//   1. locate sdb            (torrent-hub/.claude/skills/tizen-encyclopedia/deploy.md:21)
//   2. sdb devices           (debug.md:25)  — connect first if the list is empty
//   3. sdb shell 0 debug <appid>            — prints a DYNAMIC port, commonly 35000-36000
//   4. sdb forward tcp:<port> tcp:<port>
//   5. GET /json/version, /json/list        — is the inspector there at all?
//   6. GET /json/protocol                   — are Accessibility / DOMSnapshot / Input on M69?
//   7. cdp.mjs attach + Runtime.evaluate    — does the zero-dep client actually drive it?
//
// Read-only: every sdb call goes through the allowlist in protocols/allow.mjs (devices,
// connect, shell 0 debug, forward, forward --remove, version, kill-server). Nothing here can
// install, uninstall or kill an app.
//
//   node plugins/ui-probe/bakeoff/tv/probe.mjs [--appid torrenthub.tizen] [--host 192.168.1.110:26101]
//                                              [--sdb <path>] [--json <path>] [--no-connect]
//                                              [--attach-port <port>]
//
// `--attach-port` re-runs the inspector half against an existing `sdb forward`, without
// relaunching the app (a second `sdb shell 0 debug` fails while the app is running).
//
// If no TV is attached the probe stops at the first unmet precondition and emits OPEN rows
// carrying the exact command still to run. It never fabricates a pass.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connect as cdpConnect } from "../../../swarm/scripts/lib/cdp.mjs";
import { guarded, InputError, sdbPolicy } from "../protocols/allow.mjs";
import { writeArtifact } from "../protocols/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JSON = resolve(HERE, "../results/artifacts/tv.json");

const SDB_CANDIDATES = [
  "C:/Users/Andrew/.tizen-extension-platform/server/sdktools/data/tools/sdb.exe",
  "C:/Users/Andrew/.tizen-extension-platform/server/sdktools/data/tools/sdb",
];

/** The domains the plan asks about, plus the two it depends on (plan RQ6). */
const DOMAINS = ["Accessibility", "DOMSnapshot", "Input", "Runtime", "Page"];

function parseArgs(argv) {
  const opts = {
    appid: "torrenthub.tizen",
    host: "192.168.1.110:26101",
    sdb: null,
    json: DEFAULT_JSON,
    connect: true,
    attachPort: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--appid") opts.appid = argv[++i];
    else if (arg === "--host") opts.host = argv[++i];
    else if (arg === "--sdb") opts.sdb = argv[++i];
    else if (arg === "--json") opts.json = resolve(argv[++i]);
    else if (arg === "--attach-port") opts.attachPort = Number(argv[++i]);
    else if (arg === "--no-connect") opts.connect = false;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

function locateSdb(explicit) {
  for (const candidate of [explicit, process.env.SDB_PATH, ...SDB_CANDIDATES].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  const found = spawnSync("where", ["sdb"], { encoding: "utf8", windowsHide: true });
  return (found.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
}

function devicesIn(text) {
  // `sdb devices` appends the model after the state:
  //   "192.168.1.110:26101 \tdevice \tUE50TU7020KXXU"
  return String(text ?? "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^\S+\s+(device|offline|unauthorized|recovery)(\s|$)/.test(line))
    .map((line) => ({ serial: line.split(/\s+/)[0], state: line.split(/\s+/)[1] }));
}

function step(id, title, command) {
  return { id, title, command, status: "SKIP", ms: null, evidence: null };
}

/**
 * The sdb half: devices → connect → `shell 0 debug` → forward. Returns the forwarded port,
 * or null when the chain is blocked (the blocked rows are already on `steps`).
 */
async function launchUnderInspector({ sdbPath, call, add, timed, opts }) {
  const devices = add(step("sdb.devices", "sdb devices", `${sdbPath} devices`));
  let attached = [];
  await timed(devices, async () => {
    const result = await call(["devices"]);
    attached = devicesIn(result.stdout).filter((d) => d.state === "device");
    return `${result.stdout.trim()}${attached.length ? "" : "\n(no TV attached)"}`;
  });

  // debug.md:22 — connect before any sdb command
  if (attached.length === 0 && opts.connect) {
    const conn = add(step("sdb.connect", `sdb connect ${opts.host}`, `${sdbPath} connect ${opts.host}`));
    await timed(conn, async () => {
      const result = await call(["connect", opts.host]);
      if (result.code !== 0 || /error|failed/i.test(result.stderr)) {
        throw new Error(`${result.stdout}${result.stderr}`.trim());
      }
      const again = await call(["devices"]);
      attached = devicesIn(again.stdout).filter((d) => d.state === "device");
      return `${result.stdout.trim()}\n${again.stdout.trim()}${attached.length ? "" : "\n(no TV attached)"}`;
    });
  }

  if (attached.length === 0) {
    blockedFrom(add, "sdb.debug", "blocked: no TV attached (developer mode off, expired, or TV off)");
    return null;
  }

  // The app must be closed first: `sdb shell 0 debug` launches it.
  const debug = add(step("sdb.debug", "sdb shell 0 debug <appid>", `${sdbPath} shell 0 debug ${opts.appid}`));
  let port = null;
  await timed(debug, async () => {
    const result = await call(["shell", "0", "debug", opts.appid]);
    const text = `${result.stdout}${result.stderr}`.trim();
    const match = text.match(/port[:\s]+(\d{2,5})/i);
    if (!match) throw new Error(`${text}\n(no port printed: app still running, or the cert/DUID is wrong)`);
    port = Number(match[1]);
    return `${text}\n→ debug port ${port} (dynamic, never 9222 — debug.md:30)`;
  });

  if (port === null) {
    blockedFrom(add, "sdb.forward", "blocked: `sdb shell 0 debug` printed no port");
    return null;
  }

  const forward = add(step("sdb.forward", "sdb forward", `${sdbPath} forward tcp:${port} tcp:${port}`));
  await timed(forward, async () => {
    const result = await call(["forward", `tcp:${port}`, `tcp:${port}`]);
    return `${result.stdout}${result.stderr}`.trim() || `forwarded ${port}`;
  });
  return port;
}

/** Everything downstream of the blocked step, as OPEN rows naming the command still to run. */
function blockedFrom(add, fromId, reason) {
  const rows = [
    ["sdb.debug", "sdb shell 0 debug <appid>", "sdb shell 0 debug <appid>"],
    ["sdb.forward", "sdb forward tcp:<port> tcp:<port>", "sdb forward tcp:<port> tcp:<port>"],
    ["cdp.version", "GET /json/version", "curl http://127.0.0.1:<port>/json/version"],
    ["cdp.list", "GET /json/list", "curl http://127.0.0.1:<port>/json/list"],
    ["cdp.protocol", "GET /json/protocol (domain check)", "curl http://127.0.0.1:<port>/json/protocol"],
    ["cdp.attach", "cdp.mjs attach + Runtime.evaluate", "node plugins/swarm/scripts/lib/cdp.mjs --port <port>"],
  ];
  const at = rows.findIndex(([id]) => id === fromId);
  for (const [id, title, command] of rows.slice(Math.max(at, 0))) {
    add({ ...step(id, title, command), status: "OPEN", evidence: reason });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: node plugins/ui-probe/bakeoff/tv/probe.mjs [--appid torrenthub.tizen] [--host ip:port] [--sdb path] [--attach-port N]\n",
    );
    return 0;
  }

  const steps = [];
  // An attach-only run is a separate artifact: it re-measures the inspector without the launch.
  if (opts.attachPort !== null && opts.json === DEFAULT_JSON) {
    opts.json = resolve(HERE, "../results/artifacts/tv-inspector.json");
  }
  const add = (s) => {
    steps.push(s);
    return s;
  };
  const now = () => performance.now();
  const timed = async (s, fn) => {
    const started = now();
    try {
      s.evidence = await fn();
      s.status = "PASS";
    } catch (err) {
      s.status = err instanceof InputError ? "REFUSED" : "FAIL";
      s.evidence = String(err.message ?? err);
    }
    s.ms = Math.round((now() - started) * 100) / 100;
    return s;
  };

  // 1 — locate sdb
  const sdbPath = locateSdb(opts.sdb);
  const locate = add(step("sdb.locate", "locate sdb.exe", "where sdb  (or %SDB_PATH%)"));
  if (sdbPath) {
    locate.status = "PASS";
    locate.evidence = sdbPath;
  } else {
    locate.status = "OPEN";
    locate.evidence = "sdb not found. Install the Tizen VS Code extension, or pass --sdb <path>.";
    return finish(steps, opts, 0);
  }

  const policy = sdbPolicy();
  const call = guarded(
    async (args) => {
      const result = spawnSync(sdbPath, args, { encoding: "utf8", timeout: 30000, windowsHide: true });
      return { code: result.status ?? (result.error ? 2 : 0), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    policy.allow,
    "sdb",
  );

  // 2-4 — the sdb half, skipped when re-running against an existing forward.
  let port = opts.attachPort;
  if (port === null) {
    port = await launchUnderInspector({ sdbPath, call, add, timed, opts });
    if (port === null) return finish(steps, opts, 0);
  } else {
    add({
      ...step("sdb.attach-only", "sdb launch skipped", "—"),
      status: "SKIP",
      evidence: `--attach-port ${port}: inspector checks only, the app was not relaunched`,
    });
  }

  // 5 — is the inspector there, and what is driving it?
  const base = `http://127.0.0.1:${port}`;
  const version = add(step("cdp.version", "GET /json/version", `curl ${base}/json/version`));
  await timed(version, async () => {
    const response = await fetch(`${base}/json/version`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).slice(0, 400);
  });

  const list = add(step("cdp.list", "GET /json/list", `curl ${base}/json/list`));
  let target = null;
  await timed(list, async () => {
    const response = await fetch(`${base}/json/list`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const targets = await response.json();
    target = targets.find((t) => t.webSocketDebuggerUrl) ?? null;
    if (!target) throw new Error("no inspectable target in /json/list");
    return `${targets.length} target(s); webSocketDebuggerUrl present\n${target.url ?? ""}`.trim();
  });

  // 6 — the domain check the plan asks for
  const protocol = add(step("cdp.protocol", "GET /json/protocol — domain check", `curl ${base}/json/protocol`));
  await timed(protocol, async () => {
    const response = await fetch(`${base}/json/protocol`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const spec = await response.json();
    const all = (spec.domains ?? []).map((d) => d.domain);
    const answer = DOMAINS.map((name) => `${name}: ${all.includes(name) ? "present" : "ABSENT"}`).join("\n");
    return `${all.length} domains: ${all.join(", ")}\n${answer}`;
  });

  // 6b — the decisive accessibility check: M69 keeps the domain but may not have the method
  const ax = add(
    step("cdp.ax-check", "Accessibility methods + DOM fallback", `${base}/json/protocol  →  CDP Accessibility.*`),
  );
  await timed(ax, async () => {
    const spec = await (await fetch(`${base}/json/protocol`)).json();
    const commands = ((spec.domains ?? []).find((d) => d.domain === "Accessibility")?.commands ?? []).map((c) => c.name);
    const lines = [
      `Accessibility commands: ${commands.join(", ") || "(none listed)"}`,
      `getFullAXTree: ${commands.includes("getFullAXTree") ? "present" : "ABSENT"}`,
    ];
    if (!target) throw new Error("no target from /json/list");
    const session = await cdpConnect(target.webSocketDebuggerUrl);
    try {
      try {
        const doc = await session.send("DOM.getDocument", { depth: -1 });
        const partial = await session.send("Accessibility.getPartialAXTree", {
          nodeId: doc.root.nodeId,
          fetchRelatives: false,
        });
        lines.push(`getPartialAXTree(document): ${partial.nodes?.length ?? 0} node(s)`);
      } catch (err) {
        lines.push(`getPartialAXTree: ERROR ${err.message}`);
      }
      try {
        const walked = await session.send("Runtime.evaluate", {
          expression:
            "JSON.stringify({title: document.title, elements: document.querySelectorAll('*').length, chars: document.body ? document.body.innerText.length : 0})",
          returnByValue: true,
        });
        lines.push(`DOM walk: ${String(walked.result?.value ?? "")}`);
      } catch (err) {
        lines.push(`DOM walk: ERROR ${err.message}`);
      }
    } finally {
      session.close();
    }
    return lines.join("\n");
  });

  // 7 — does cdp.mjs attach and evaluate?
  const attach = add(
    step("cdp.attach", "cdp.mjs attach + Runtime.evaluate", `cdp.mjs connect(${target?.webSocketDebuggerUrl ?? "<url>"})`),
  );
  await timed(attach, async () => {
    if (!target) throw new Error("no target from /json/list");
    const session = await cdpConnect(target.webSocketDebuggerUrl);
    try {
      const result = await session.send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
      return `Runtime.evaluate('1+1') = ${JSON.stringify(result.result?.value)}`;
    } finally {
      session.close();
    }
  });

  return finish(steps, opts, steps.some((s) => s.status === "FAIL") ? 1 : 0);
}

function finish(steps, opts, code) {
  const rows = steps.map(({ id, title, command, status, ms, evidence }) => ({ id, title, command, status, ms, evidence }));
  // SKIP is neutral (the attach-only path skips the sdb half); anything else decides.
  const active = rows.filter((r) => r.status !== "SKIP");
  const verdict = active.some((r) => r.status === "FAIL" || r.status === "REFUSED")
    ? "FAIL"
    : active.some((r) => r.status === "OPEN")
      ? "OPEN"
      : "PASS";
  writeArtifact(opts.json, {
    schema: "ui-probe-bakeoff/tv@1",
    generatedAt: new Date().toISOString(),
    appid: opts.appid,
    host: opts.host,
    verdict,
    steps: rows,
  });
  for (const row of rows) {
    process.stdout.write(`${row.status.padEnd(7)} ${row.id.padEnd(13)} ${row.command}\n`);
    if (row.evidence) process.stdout.write(`        ${String(row.evidence).replace(/\n/g, "\n        ")}\n`);
  }
  process.stdout.write(`\nverdict: ${verdict}   artifact: ${opts.json}\n`);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
