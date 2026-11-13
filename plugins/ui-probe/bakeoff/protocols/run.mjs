// RQ7 runner: one harness, every protocol contender, one table.
//
//   node plugins/ui-probe/bakeoff/protocols/run.mjs [--repeats 5] [--only http,tcp,ssh]
//                                                    [--json <path>] [--md <path>]
//
// Real dependencies are constructed HERE, once, and injected into the adapters. Nothing
// below a factory defaults to a real socket, fetch or process at definition time, which is
// what lets the offline smoke test drive the same adapters with fakes.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as nodeNet from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpAdapter } from "./adapters/http-fetch.mjs";
import { createHurlAdapter } from "./adapters/hurl.mjs";
import { createQbittorrentAdapter } from "./adapters/qbittorrent.mjs";
import { createSshAdapter } from "./adapters/ssh-batch.mjs";
import { createTcpAdapter } from "./adapters/tcp-net.mjs";
import { FIXTURE_SESSION, startHttpFixture } from "./fixtures/http-server.mjs";
import { HUB_PORT, probeListening } from "./fixtures/hub.mjs";
import { startTcpFixture } from "./fixtures/tcp-echo.mjs";
import { DEFAULT_REPEATS, drive, driveGuards, SCHEMA, toGuardMarkdown, toMarkdown, writeArtifact } from "./harness.mjs";
import { TASKS, withAddress } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JSON = resolve(HERE, "../results/artifacts/protocols.json");

const SSH_PATH = "C:/Windows/System32/OpenSSH/ssh.exe";

function parseArgs(argv) {
  const opts = { repeats: DEFAULT_REPEATS, only: null, json: DEFAULT_JSON };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repeats") opts.repeats = Number(argv[++i]);
    else if (arg === "--only") opts.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--json") opts.json = resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

function sshSpawn(argv, { timeoutMs }) {
  const bin = existsSync(SSH_PATH) ? SSH_PATH : "ssh.exe";
  const result = spawnSync(bin, argv, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return {
    code: result.status ?? (result.error ? 2 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error?.message ?? ""),
  };
}

function which(name) {
  const result = spawnSync("where", [name], { encoding: "utf8", windowsHide: true });
  return (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: node plugins/ui-probe/bakeoff/protocols/run.mjs [--repeats 5] [--only http,tcp,ssh] [--json <path>]\n",
    );
    return 0;
  }

  const hubListening = await probeListening({ port: HUB_PORT });
  const http = hubListening
    ? { kind: "hub", host: "127.0.0.1", port: HUB_PORT, origin: `http://127.0.0.1:${HUB_PORT}`, headers: {}, requests: null }
    : await startLocalHttp();

  const tcp = await startTcpFixture();

  const adapters = [
    createHttpAdapter({
      fetchImpl: (url, init) => globalThis.fetch(url, init),
      target: http,
      headers: http.headers,
      secrets: [FIXTURE_SESSION],
    }),
    createTcpAdapter({ net: nodeNet, host: tcp.host, port: tcp.port }),
    createSshAdapter({ spawn: sshSpawn, net: nodeNet }),
    createHurlAdapter({ which }),
    createQbittorrentAdapter(),
  ];

  const family = (adapter) => (adapter.id === "http-fetch" ? "http" : adapter.id === "tcp-net" ? "tcp" : adapter.id === "ssh-batch" ? "ssh" : adapter.id);
  const selected = opts.only ? adapters.filter((a) => opts.only.includes(family(a)) || opts.only.includes(a.id)) : adapters;

  const tasks = withAddress(TASKS, { origin: http.origin, port: tcp.port });

  try {
    const rows = await drive({ adapters: selected, tasks, repeats: opts.repeats });
    const guards = await driveGuards({ adapters: selected });

    // The write-proof the HTTP guard rests on: the fixture log must contain no writes.
    const fixtureWrites = http.requests ? http.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD") : null;

    const payload = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      repeats: opts.repeats,
      target: { kind: http.kind, origin: http.origin, fixtureWrites: fixtureWrites?.length ?? null },
      rows,
      guards,
      notes: [
        http.kind === "hub"
          ? "HTTP target was a hub fixture already listening on :8001; no session cookie was available without credentials."
          : "No hub fixture was listening on :8001; the HTTP probe ran against the local node:http fixture.",
        "qBittorrent and Hurl are OPEN rows: neither was contacted/installed.",
      ],
    };

    writeArtifact(opts.json, payload);
    process.stdout.write(`${toMarkdown(rows)}\n\n${toGuardMarkdown(guards)}\n\nartifact: ${opts.json}\n`);
    return rows.every((row) => row.status !== "FAIL") && guards.every((g) => g.blocked) ? 0 : 1;
  } finally {
    await tcp.close();
    if (http.close) await http.close();
  }
}

async function startLocalHttp() {
  const fixture = await startHttpFixture();
  return {
    kind: "fixture",
    host: fixture.host,
    port: fixture.port,
    origin: fixture.origin,
    headers: { cookie: `profile_session=${FIXTURE_SESSION}` },
    requests: fixture.requests,
    close: fixture.close,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
