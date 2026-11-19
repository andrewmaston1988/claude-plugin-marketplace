// A test-built broker client must never start a broker of its own. The client's
// self-heal spawns it detached, so a broker started that way outlives the test
// process, holds the checkout and keeps the port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
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

  // A1/A2 only guard a client built through the harness. This row is the guard
  // for every other test file: a call that builds its own client with no spawn
  // stub can reach the self-heal and leak a broker the test never learns about.
  const TESTS_DIR = fileURLToPath(new URL("..", import.meta.url));
  const HARNESS = path.join(TESTS_DIR, "remote", "broker-harness.mjs");
  const CLIENT_CALL = /\bcreateBrokerClient\s*\(/g;

  function mjsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...mjsFiles(p));
      else if (entry.name.endsWith(".mjs")) out.push(p);
    }
    return out;
  }

  // Index of the bracket that closes `open`, skipping string and comment bodies
  // so a bracket inside one cannot end the call early.
  function closeOf(src, open) {
    const closing = { "(": ")", "{": "}", "[": "]" };
    const stack = [];
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) return src.length; continue; }
      if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; if (i === 0) return src.length; continue; }
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
        continue;
      }
      if (closing[c]) stack.push(closing[c]);
      else if (c === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) return i;
      }
    }
    return src.length;
  }

  test("A3: every client the test files build is guarded against the self-heal", () => {
    const harnessSrc = fs.readFileSync(HARNESS, "utf8");
    const defStart = harnessSrc.indexOf("export function testBrokerClient");
    const defEnd = defStart < 0 ? -1 : closeOf(harnessSrc, harnessSrc.indexOf("{", defStart));
    const offenders = [];
    for (const file of mjsFiles(TESTS_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(CLIENT_CALL)) {
        if (file === HARNESS && m.index >= defStart && m.index <= defEnd) continue;
        const open = m.index + m[0].lastIndexOf("(");
        if (/\b_spawn\b/.test(src.slice(open, closeOf(src, open)))) continue;
        const rel = path.relative(TESTS_DIR, file).split(path.sep).join("/");
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    assert.deepEqual(offenders, [],
      `these clients can reach the self-heal — pass _spawn or build them through testBrokerClient: ${offenders.join(", ")}`);
  });
}
