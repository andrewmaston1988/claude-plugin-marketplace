import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectHost, hostProviders, registryPath, resolveInstalled, PLUGIN_KEY } from "../src/host.mjs";
import * as daemon from "../src/serve/daemon.mjs";

// The host is whatever agent swarm is running inside. Setup uses it for one
// decision — which provider to turn on for a fresh install — so the failure that
// matters is guessing: an unrecognised host must produce no recommendation at
// all, and the operator gets asked instead.

test("detectHost: Claude Code's own marker means claude", () => {
  equal(detectHost({ CLAUDECODE: "1" }), "claude");
});

test("detectHost: a bare environment is unknown, not claude", () => {
  equal(detectHost({}), "unknown");
  // An omitted env reads process.env, which under the test runner carries the real
  // session's CLAUDECODE — so pin the fallback, not the value it lands on.
  equal(detectHost(undefined), detectHost(process.env), "no env means process.env, not no markers");
  // The marker is the value, not the key's presence — a stray CLAUDECODE=0 is not
  // Claude Code, and reading it as one turns a provider on by accident.
  equal(detectHost({ CLAUDECODE: "0" }), "unknown");
});

test("detectHost: the explicit override names the host whatever the markers say", () => {
  equal(detectHost({ SWARM_HOST: "codex" }), "codex");
  equal(detectHost({ SWARM_HOST: "claude", CLAUDECODE: "0" }), "claude");
  equal(detectHost({ SWARM_HOST: "nonsense" }), "unknown", "an unrecognised override is unknown, never passed through");
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
