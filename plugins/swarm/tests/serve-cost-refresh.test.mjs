import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "../src/serve/server.mjs";
import { rateCardStorePath } from "../src/rate-card.mjs";

const noopEstate = {
  current: () => Promise.resolve({ version: 1, projects: [] }),
  refresh: () => {},
  onSnapshot: () => {},
  close: () => {},
};

async function getCost(server) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/api/cost" }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

test("serve: Cost refreshes prices once with its home-bound path while a refresh is in flight", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-cost-refresh-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  const calls = [];
  let finishRefresh;
  const refreshPending = new Promise((resolve) => { finishRefresh = resolve; });
  const server = createServer({
    home,
    cfg: { quietWarnSecs: 60, grading: { enabled: false }, dashboard: { port: 0, bind: "127.0.0.1", token: null } },
    log: () => {},
    _watch: () => ({ close() {} }),
    _estate: noopEstate,
    // The real reader hydrates Claude from the operator's own ~/.claude catalog,
    // so pin it: this row is about the price refresh, not the roster's contents.
    _modelRoster: () => ({ models: [], errors: {} }),
    _refreshRoster: () => Promise.resolve(),
    _refreshPrices: (options) => { calls.push(options); return refreshPending; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await getCost(server)).status, 200);
    assert.equal((await getCost(server)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, rateCardStorePath({ ...process.env, SWARM_HOME: home }));
    assert.deepEqual(calls[0].rosterIds, {});
    assert.equal(calls[0].out, calls[0].err);
    assert.equal(typeof calls[0].out, "function");
  } finally {
    finishRefresh();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

// The roster is renewed the same way the prices are: fired off the request path,
// one at a time, bound to this dashboard's home rather than the process env.
test("serve: Cost fires a roster refresh once while one is in flight, bound to its home", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-roster-refresh-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  const calls = [];
  let finishRefresh;
  const refreshPending = new Promise((resolve) => { finishRefresh = resolve; });
  const cfg = { quietWarnSecs: 60, grading: { enabled: false }, dashboard: { port: 0, bind: "127.0.0.1", token: null } };
  const server = createServer({
    home,
    cfg,
    log: () => {},
    _watch: () => ({ close() {} }),
    _estate: noopEstate,
    _refreshRoster: (options) => { calls.push(options); return refreshPending; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await getCost(server)).status, 200);
    assert.equal((await getCost(server)).status, 200);
    assert.equal(calls.length, 1, "a second request must not stack a second refresh");
    assert.equal(calls[0].env.SWARM_HOME, home, "the refresh must be bound to this dashboard's home");
    assert.equal(calls[0].config, cfg);
    assert.equal(typeof calls[0].registry.list, "function");
  } finally {
    finishRefresh();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

// The rows the Cost screen prices are the reader's, not a second parse of the
// cache file — one reader, whatever the dashboard is bound to.
test("serve: the Cost roster is whatever the reader returns, read through the home-bound reader", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-roster-reader-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  const seen = [];
  const priced = [];
  const server = createServer({
    home,
    cfg: { quietWarnSecs: 60, grading: { enabled: false }, dashboard: { port: 0, bind: "127.0.0.1", token: null } },
    log: () => {},
    _watch: () => ({ close() {} }),
    _estate: noopEstate,
    _refreshPrices: (options) => { priced.push(options); return Promise.resolve(); },
    _modelRoster: (options) => {
      seen.push(options);
      return { models: [{ provider: "codex", model: "gpt-6-luna" }], errors: {} };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { status, body } = await getCost(server);
    assert.equal(status, 200, body);
    assert.ok(seen.length, "the cost roster never went through the reader");
    assert.equal(seen[0].env.SWARM_HOME, home);
    assert.deepEqual(priced[0].rosterIds, { codex: ["gpt-6-luna"] }, "the price refresh is priced for the reader's rows");
    const codex = JSON.parse(body).sections.find((s) => s.provider === "codex");
    assert.ok(codex.spread.some((row) => row.model === "gpt-6-luna"),
      `the reader's rows never reached the cost screen: ${JSON.stringify(codex.spread)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
