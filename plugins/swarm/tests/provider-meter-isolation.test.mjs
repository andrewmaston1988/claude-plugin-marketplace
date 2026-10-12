import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { accessSync, constants, existsSync } from "node:fs";
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
