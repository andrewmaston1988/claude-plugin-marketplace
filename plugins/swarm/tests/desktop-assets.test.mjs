// The desktop assets ride the phone's gate: desktop.css is inlined by pageHtml() (a
// static <link> carries no ?t= and 401s) and desktop.js is served under the token
// exactly as perf.js is — lazily, so a phone never pays for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "../src/serve/server.mjs";
import { pageHtml } from "../src/serve/page-assets.mjs";

const get = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path }, (res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  }).on("error", reject);
});

async function withServer(fn) {
  const home = mkdtempSync(join(tmpdir(), "swarm-desktop-assets-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  const server = createServer({
    home,
    cfg: { quietWarnSecs: 60, dashboard: { port: 0, bind: "127.0.0.1", token: "s3cret" } },
    _watch: () => ({ close() {} }),
    _estate: { current: () => Promise.resolve({ version: 1, projects: [] }), refresh() {}, onSnapshot() {}, close() {} },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
}

test("pageHtml inlines desktop.css inside its one breakpoint, leaving no marker", () => {
  const page = pageHtml();
  assert.match(page, /@media \(min-width: 68\.75em\)/);
  assert.match(page, /--layout:\s*desktop/);
  assert.doesNotMatch(page, /\/\*@inline /);
});

test("desktop.js is served under the token, like perf.js", async () => {
  await withServer(async (port) => {
    const js = await get(port, "/desktop.js?t=s3cret");
    assert.equal(js.status, 200);
    assert.match(js.body, /swarmDesktop/, "the file the page expects, not an empty 200");
    assert.equal((await get(port, "/desktop.js")).status, 401, "the gate covers it too");
    const page = await get(port, "/?t=s3cret");
    assert.equal(page.status, 200);
    assert.match(page.body, /@media \(min-width: 68\.75em\)/, "the served page carries the desktop rules");
  });
});
