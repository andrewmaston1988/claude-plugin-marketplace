import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, connect } from "node:net";
import { doctorChecks, doctorExit } from "../src/serve/daemon.mjs";
import { runCli } from "./helpers/cli.mjs";

// `swarm doctor` reports the probe setup asks its provider question from, so a
// provider that is switched on and cannot dispatch is visible outside setup. The
// two halves tested here: the row a probe result becomes, and the wiring that
// gives doctor the configured providers to probe at all. Rows live in their own
// file because daemon.test.mjs is at the 500-line ratchet.

const GOOD = {
  record: { pid: 4321, port: 7331, version: "v1", listening: true }, alive: true,
  installed: { version: "v1" }, port: 7331, startupDir: null, shimPath: "/s",
  _probePort: async () => ({ reachable: true }), _firewall: async () => ({ found: true }),
};

test("doctor: every enabled provider gets a probe row, and an unprobed one is unknown, never a pass", async () => {
  const seen = [];
  const config = { providers: { ollama: { enabled: true, url: "http://localhost:11434" } } };
  const checks = await doctorChecks({
    ...GOOD, providers: ["ollama", "codex", "claude"], config,
    _probeProvider: async (id, opts) => {
      seen.push([id, opts.config]);
      if (id === "ollama") return { id, ok: false, detail: "endpoint http://localhost:11434 is unreachable (connect ECONNREFUSED)", probed: true };
      if (id === "codex") return { id, ok: true, detail: null, probed: false };
      return { id, ok: true, detail: null, probed: true };
    },
  });

  assert.equal(seen.length, 3, "one probe per configured provider — every entry in the caller's list is asked");
  assert.equal(seen[0][1], config, "the probe runs against the loaded config, not an empty one");
  for (const c of checks.filter((c) => c.name.startsWith("provider:"))) {
    assert.deepEqual(Object.keys(c).sort(), ["detail", "name", "status"], "same shape as every other check");
  }
  assert.equal(checks.find((c) => c.name === "provider:ollama").status, "fail");
  assert.match(checks.find((c) => c.name === "provider:ollama").detail, /unreachable/);
  // The reason `probed` exists: no preflight to run is not a preflight that passed.
  assert.equal(checks.find((c) => c.name === "provider:codex").status, "unknown");
  assert.equal(checks.find((c) => c.name === "provider:codex").detail, "no preflight to run");
  assert.equal(checks.find((c) => c.name === "provider:claude").status, "pass");
  assert.equal(doctorExit(checks), 1, "a switched-on provider that cannot dispatch is a failure to report");

  // A failing probe that names no cause still says something.
  const bare = await doctorChecks({ ...GOOD, providers: ["ollama"], _probeProvider: async (id) => ({ id, ok: false, detail: null, probed: true }) });
  assert.equal(bare.find((c) => c.name === "provider:ollama").detail, "preflight failed");

  // No provider list is not a failure — the rows are the caller's list, and the
  // default must not try to build a registry of its own.
  const none = await doctorChecks(GOOD);
  assert.equal(none.some((c) => c.name.startsWith("provider:")), false);
  assert.equal(doctorExit(none), 0);
});

// ── the CLI wiring ───────────────────────────────────────────────────────────
// The rows above pass with doctor.mjs correct and cmdServe passing nothing, which
// is exactly the state `probeProvider` was found in: exported, called from nowhere.

const tmp = () => mkdtempSync(join(tmpdir(), "swarm-doctor-"));
const portAnswers = (port) => new Promise((resolve) => {
  const sock = connect({ port, host: "127.0.0.1" });
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.once("connect", () => done(true));
  sock.once("error", () => done(false));
  setTimeout(() => done(false), 1000);
});

test("swarm doctor: an enabled provider's probe result reaches the operator", async () => {
  const dir = tmp();
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const deadPort = srv.address().port;
  await new Promise((r) => srv.close(r));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: {
      claude: { allowedRoots: [dir] },
      codex: { enabled: true },
      ollama: { enabled: true, url: `http://127.0.0.1:${deadPort}` },
    },
  }), "utf8");
  try {
    assert.equal(await portAnswers(deadPort), false, "the probe target must really be dead, or the row proves nothing");
    // APPDATA is pinned to the tmp dir so the autostart check reads nothing real.
    const r = runCli(["serve", "doctor"], { cwd: dir, env: { SWARM_HOME: home, APPDATA: dir } });
    assert.match(r.stdout, /provider:claude: /, `no provider rows at all:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /✗ provider:ollama: .*(unreachable|did not answer)/, r.stdout);
    assert.match(r.stdout, /⚠ provider:codex: no preflight to run/, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
