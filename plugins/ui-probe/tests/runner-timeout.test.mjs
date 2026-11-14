// The fetch bound must hold the event loop: a child whose only pending work is a fetch that
// never settles has nothing else to keep Node alive until the timeout aborts it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNNER = pathToFileURL(fileURLToPath(new URL("../src/runner.mjs", import.meta.url))).href;

const CHILD = `
const { run } = await import(${JSON.stringify(RUNNER)});
const result = await run(
  { id: "timeout", backend: "http", steps: [
    { expect_json: { url: "http://127.0.0.1:1/page", path: "ok", equals: true } },
  ] },
  {
    fetchTimeoutMs: 50,
    // Never settles on its own; only the op's timeout may end it.
    _fetch: (url, options) => new Promise((_, reject) => {
      if (!options?.signal) return;
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    }),
  },
);
process.stdout.write(JSON.stringify({ outcome: result.outcome, exitCode: result.exitCode }));
`;

test("row 25: the fetch timeout holds the event loop open when the fetch never settles", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(
    child.stdout,
    '{"outcome":"inconclusive","exitCode":2}',
    `child exited ${child.status}: ${child.stderr}`,
  );
});
