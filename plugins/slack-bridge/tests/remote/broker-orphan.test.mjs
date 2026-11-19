// A test-built broker client must never start a broker of its own. The client's
// self-heal spawns it detached, so a broker started that way outlives the test
// process, holds the checkout and keeps the port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { testBrokerClient } from "./broker-harness.mjs";

const self = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function listening(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

// All a test can do for a broker it did not spawn: ask it to shut down.
async function reap(port) {
  try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) }); } catch {}
  for (let i = 0; i < 20 && (await listening(port)); i++) await sleep(100);
}

const INNER = process.env.BROKER_ORPHAN_INNER === "1";

if (INNER) {
  // The failing test A2 forces: it touches the client, then its assertion fails.
  test("inner: a test whose own assertion fails", async () => {
    const port = Number(process.env.BROKER_ORPHAN_PORT);
    const client = testBrokerClient(port);
    await client.ensureBroker().catch(() => {});
    assert.fail("forced failure");
  });
} else {
  test("A1: a test-built client on a dead port leaves no broker listening", async (t) => {
    const port = await freePort();
    t.after(() => reap(port));
    const client = testBrokerClient(port);
    await client.ensureBroker().catch(() => {});
    await sleep(300);
    assert.equal(await listening(port), false,
      "the client spawned a real detached broker on a dead port — a test must inject a spawn stub");
  });

  // A2 drives the scenario through a child run whose test fails. The inner test
  // reaps nothing, so only this outer row can shut down a broker the client
  // spawned: if one is alive here, it outlived the failing child.
  test("A2: a test that failed after touching the client leaves no broker listening", async (t) => {
    const port = await freePort();
    t.after(() => reap(port));
    // NODE_TEST_CONTEXT would make the grandchild think it is already a test-runner child.
    const env = { ...process.env, BROKER_ORPHAN_INNER: "1", BROKER_ORPHAN_PORT: String(port) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", self], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    const status = await new Promise((resolve) => child.on("exit", resolve));
    assert.notEqual(status, 0, "the inner run must fail for this row to mean anything");
    await sleep(300);
    assert.equal(await listening(port), false,
      "a failing test left a real detached broker behind — the client spawned one it cannot reap");
  });
}
