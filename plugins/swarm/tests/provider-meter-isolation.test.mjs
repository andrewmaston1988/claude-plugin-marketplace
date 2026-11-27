import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { createCodexProviderAdapter } from "../src/codex.mjs";
import { defaultProviderAdapters } from "../src/providers.mjs";

function resolveBareCodex(pathValue) {
  const windows = process.platform === "win32";
  for (const directory of pathValue.split(delimiter)) {
    for (const name of windows ? ["codex.com", "codex.exe"] : ["codex"]) {
      const candidate = join(directory, name);
      if (!existsSync(candidate)) continue;
      if (windows) return resolve(candidate);
      try {
        accessSync(candidate, constants.X_OK);
        return resolve(candidate);
      } catch {}
    }
  }
  return null;
}

test("Codex preflight resolves the test stub and dispatches without a client", async () => {
  const stubDir = join(process.env.SWARM_HOME, "bin");
  const resolved = resolveBareCodex(process.env.PATH || process.env.Path || "");
  ok(resolved, "bare codex must resolve on PATH");
  equal(dirname(resolved), resolve(stubDir), `codex resolved outside the preload stub dir: ${resolved}`);

  const result = await createCodexProviderAdapter().capabilities.preflight({
    config: { providers: { codex: { enabled: true } } },
    tasks: [{ id: "unmetered" }],
  });
  equal(result.ok, true);
});

test("the Windows codex stub is a small binary, not a copy of node", { skip: process.platform !== "win32" }, () => {
  const stub = join(process.env.SWARM_HOME, "bin", "codex.exe");
  ok(statSync(stub).size < 1024 * 1024, `codex stub is ${statSync(stub).size} bytes`);
});

test("the codex stub exits non-zero on app-server", () => {
  const result = spawnSync("codex", ["app-server", "--listen", "stdio://"], { encoding: "utf8" });
  equal(result.error, undefined);
  ok(result.status !== 0 && result.status !== null, `stub exited ${result.status}`);
});

test("Claude preflight credentials resolve inside the throwaway test home", async () => {
  const credentialsPath = process.env.SWARM_CREDENTIALS;
  ok(credentialsPath, "preload must set SWARM_CREDENTIALS");
  equal(dirname(resolve(credentialsPath)), resolve(process.env.SWARM_HOME),
    `Claude credentials resolved outside the throwaway dir: ${credentialsPath}`);

  const claude = defaultProviderAdapters().find((adapter) => adapter.id === "claude");
  const result = await claude.capabilities.preflight({
    config: { providers: { claude: { enabled: true } } },
    tasks: [{ id: "unmetered" }],
  });
  equal(result.ok, true);
});

test("the test worker inherits the preload's single throwaway home", () => {
  equal(process.env.SWARM_TEST_HOME, "1");
  ok(process.env.SWARM_HOME);
  ok(existsSync(process.env.SWARM_HOME));
});
