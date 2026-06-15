import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "claude-investigate.mjs");

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

test("CLI — help lists all subcommands", () => {
  const { stdout, status } = runCli("--help");
  assert.equal(status, 0, "exit code should be 0");
  for (const sub of ["locate", "summary", "errors", "retries", "pivots", "report", "doctor"]) {
    assert.ok(stdout.includes(sub), `help should mention '${sub}'`);
  }
});

test("CLI — unknown subcommand exits 1", () => {
  const { stderr, status } = runCli("bogus-subcommand");
  assert.equal(status, 1, "exit code should be 1");
  assert.ok(stderr.includes("Unknown subcommand"), "should report unknown subcommand");
});

test("CLI — locate requires agent-id arg", () => {
  const { stderr, status } = runCli("locate");
  assert.equal(status, 1, "exit code should be 1");
  assert.ok(stderr.includes("locate"), "should echo usage with 'locate'");
});
