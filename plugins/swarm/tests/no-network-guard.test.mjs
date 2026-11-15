// The guard installed by isolate-home.mjs is the class fix behind the serve-test
// flake: a test that reaches a vendor used to kill node outright, so the run
// reported a bare `test failed`. It must now fail the file and name the URL.
import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./fixtures/network-guard-child.mjs", import.meta.url));

// In a child: this file runs under the same guard, so a live fetch in it would be
// refused here too, and the point is what the child's report says.
test("a test file that fetches a non-loopback URL fails, naming the URL", () => {
  // NODE_TEST_CONTEXT makes the child think it is nested and skip its files.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", CHILD], { encoding: "utf8", env });
  const output = `${run.stdout}${run.stderr}`;
  assert.notEqual(run.status, 0, `the child passed with a live fetch:\n${output}`);
  assert.match(output, /network-guard\.invalid\/pricing/, `the failure must name the URL it refused:\n${output}`);
});

test("loopback fetches pass straight through", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  // No host: dual-stack, so the IPv4 literal, `localhost` and the IPv6 literal
  // all reach the same listener.
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const res = await fetch(`http://${host}:${port}/`);
      assert.equal(res.status, 200, `${host} must not be blocked`);
      assert.equal(await res.text(), "ok");
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("a non-absolute input reaches the original fetch unchanged", async () => {
  await assert.rejects(fetch("not a url"), (err) => {
    assert.equal(err.name, "TypeError", "the caller must still see fetch's own parse error");
    assert.doesNotMatch(err.message, /network access in a swarm test/, "the guard must not claim this one");
    return true;
  });
});
