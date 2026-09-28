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
