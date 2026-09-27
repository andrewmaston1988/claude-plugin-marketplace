// pageHtml() is the page both the server and the harness boot: markers become the
// named asset's text, and an asset that would close its inline element is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "../src/serve/server.mjs";
import { pageHtml } from "../src/serve/page-assets.mjs";

test("pageHtml: an inline marker is replaced by the named asset's contents", () => {
  const live = readFileSync(new URL("../src/serve/live.js", import.meta.url), "utf8");
  assert.equal(pageHtml("<script>/*@inline live.js*/</script>"), `<script>${live}</script>`);
});

test("pageHtml: an asset holding a closing </script> is refused, not inlined", () => {
  // page.html itself closes its own <script>, so inlining it must throw.
  assert.throws(() => pageHtml("<script>/*@inline page.html*/</script>"), /cannot be inlined/);
});

// The page's own components ride inside it: a static <script src> would carry no ?t= and 401.
test("token: the served page arrives with components.js inlined, no marker left", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-page-assets-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  const server = createServer({
    home,
    cfg: { quietWarnSecs: 60, dashboard: { port: 0, bind: "127.0.0.1", token: "s3cret" } },
    _watch: () => ({ close() {} }),
    _estate: { current: () => Promise.resolve({ version: 1, projects: [] }), refresh() {}, onSnapshot() {}, close() {} },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const page = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: server.address().port, path: "/?t=s3cret" }, (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /window\.swarmUI = \{/);
    assert.doesNotMatch(page.body, /\/\*@inline /);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});
