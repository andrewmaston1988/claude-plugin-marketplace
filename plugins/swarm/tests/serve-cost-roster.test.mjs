// CS-4 made readModelsCache THROW on a corrupt roster where it used to return null.
// The dashboard's cost view reads that roster, so without a catch the throw escapes
// the request and 500s a page whose only job is display. The row drives the real
// endpoint, not the helper: a unit test on costRoster would pass with the catch
// removed from the request path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "../src/serve/server.mjs";

const noopEstate = {
  current: () => Promise.resolve({ version: 1, projects: [] }),
  refresh: () => {},
  onSnapshot: () => {},
  close: () => {},
};

async function getPerf(home) {
  const server = createServer({
    home,
    cfg: { quietWarnSecs: 60, grading: { enabled: true }, dashboard: { port: 0, bind: "127.0.0.1", token: null } },
    _watch: () => ({ close() {} }),
    _estate: noopEstate,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/perf" }, (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("serve: a corrupt models-cache renders an empty cost roster instead of 500ing the perf page", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-cost-roster-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  // Not JSON at all — the shape readModelsCache now throws on.
  writeFileSync(join(home, "models-cache.json"), "{ this is not json", "utf8");
  try {
    const { status, body } = await getPerf(home);
    assert.equal(status, 200, `a corrupt roster must not fail the request; got ${status}: ${body.slice(0, 200)}`);
    const parsed = JSON.parse(body);
    assert.ok(parsed.views?.cost, "the cost view must still render");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
