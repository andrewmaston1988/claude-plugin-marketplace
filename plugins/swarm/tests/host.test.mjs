import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectHost, hostProviders, registryPath, resolveInstalled, PLUGIN_KEY } from "../src/host.mjs";
import * as daemon from "../src/serve/daemon.mjs";

// The host is whatever agent swarm is running inside. Setup uses it for one
// decision — which provider to turn on for a fresh install — so the failure that
// matters is guessing: an unrecognised host must produce no recommendation at
// all, and the operator gets asked instead.
//
// The honest signal is WHERE THIS COPY IS INSTALLED, not an env var:
// CLAUDE_PLUGIN_ROOT is set when the host invokes a hook, and nobody types
// `swarm config init` through one. So the rows below either inject the resolved
// install or point SWARM_PLUGIN_REGISTRY at a registry of their own — the default
// lookup reads the operator's real registry and would pass or fail by machine.

const WIN_CLAUDE_INSTALL = "C:\\Users\\a\\.claude\\plugins\\cache\\andrewmaston1988-claude-plugins\\swarm\\0d6f126";
const POSIX_CLAUDE_INSTALL = "/home/a/.claude/plugins/cache/andrewmaston1988-claude-plugins/swarm/0d6f126";
const CODEX_INSTALL = "C:\\Users\\a\\.codex\\plugins\\swarm\\0d6f126";

test("detectHost: the running copy's install path names the host, on either separator", () => {
  equal(detectHost({}, { installed: { installPath: WIN_CLAUDE_INSTALL } }), "claude");
  equal(detectHost({}, { installed: { installPath: POSIX_CLAUDE_INSTALL } }), "claude", "a POSIX install path is the same evidence");
  equal(detectHost({}, { installed: { installPath: CODEX_INSTALL } }), "codex");
});

test("detectHost: an install path under no host's tree is unknown, never a guess", () => {
  // A source checkout is not an install — nothing about `C:\code\...` says which
  // agent is running it, and a wrong answer here turns a provider on by accident.
  equal(detectHost({}, { installed: { installPath: "C:\\code\\claude-plugin-marketplace" } }), "unknown");
  equal(detectHost({}, { installed: null }), "unknown", "unreadable or empty registry");
});

test("detectHost: the install path comes from the registry the env names", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-host-"));
  try {
    const reg = join(dir, "installed_plugins.json");
    writeFileSync(reg, JSON.stringify({ plugins: { [PLUGIN_KEY]: [{ scope: "user", installPath: CODEX_INSTALL, lastUpdated: "2026-01-01" }] } }));
    // Hardcoding the default registry instead of threading env through would read
    // the operator's own install here and never see this one.
    equal(detectHost({ SWARM_PLUGIN_REGISTRY: reg }), "codex");
    equal(detectHost({ SWARM_PLUGIN_REGISTRY: join(dir, "missing.json") }), "unknown", "an unreadable registry is unknown, not a guess");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectHost: the marker is the fallback, and it is the value that counts", () => {
  equal(detectHost({ CLAUDECODE: "1" }, { installed: null }), "claude");
  // A stray CLAUDECODE=0 is not Claude Code, and reading the key's presence
  // instead of its value turns a provider on by accident.
  equal(detectHost({ CLAUDECODE: "0" }, { installed: null }), "unknown");
  // An install path outranks the marker: it is evidence, the marker is a hint.
  equal(detectHost({ CLAUDECODE: "0" }, { installed: { installPath: WIN_CLAUDE_INSTALL } }), "claude");
});

test("detectHost: a bare environment resolves what it can and guesses nothing beyond it", () => {
  equal(detectHost({}, { installed: null }), "unknown");
  // An omitted env reads process.env, which under the test runner carries the real
  // session's CLAUDECODE — so pin the fallback, not the value it lands on.
  equal(detectHost(undefined, { installed: null }), detectHost(process.env, { installed: null }), "no env means process.env, not no markers");
});

test("detectHost: the explicit override names the host whatever the markers say", () => {
  equal(detectHost({ SWARM_HOST: "codex" }, { installed: null }), "codex");
  equal(detectHost({ SWARM_HOST: "claude", CLAUDECODE: "0" }, { installed: null }), "claude");
  equal(detectHost({ SWARM_HOST: "codex" }, { installed: { installPath: WIN_CLAUDE_INSTALL } }), "codex", "the override outranks the install path");
  equal(detectHost({ SWARM_HOST: "nonsense" }, { installed: { installPath: WIN_CLAUDE_INSTALL } }), "unknown", "an unrecognised override is unknown, never passed through and never silently dropped");
});

test("hostProviders: a known host names the provider it can dispatch, unknown names none", () => {
  deepEqual(hostProviders("claude"), ["claude"]);
  deepEqual(hostProviders("codex"), ["codex"]);
  deepEqual(hostProviders("unknown"), [], "the fail-safe: nothing to recommend, so setup asks");
  deepEqual(hostProviders(), []);
});

test("registryPath: honours the escape hatch and otherwise sits under the home directory", () => {
  equal(registryPath({ SWARM_PLUGIN_REGISTRY: "/tmp/reg.json" }), "/tmp/reg.json");
  equal(registryPath({}), join(homedir(), ".claude", "plugins", "installed_plugins.json"));
});

// The whole point of the move: daemon.mjs used to mirror these, and a mirror drifts.
// Identity, not equality of behaviour — a re-copied body passes every behavioural row
// in daemon.test.mjs and still leaves two definitions to keep in step.
test("daemon re-exports the registry constants rather than keeping its own copy", () => {
  equal(daemon.PLUGIN_KEY, PLUGIN_KEY);
  equal(daemon.registryPath, registryPath, "same function, not a same-looking one");
  equal(daemon.resolveInstalled, resolveInstalled, "same function, not a same-looking one");
});
