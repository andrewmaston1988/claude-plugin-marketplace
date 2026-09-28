// The desktop assets ride the phone's gate: desktop.css is inlined by pageHtml() (a
// static <link> carries no ?t= and 401s) and the lazy scripts are served under the token
// exactly as perf.js is — lazily, so a phone never pays for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cfg, withServer } from "./helpers/serve-fixture.mjs";
import { pageHtml } from "../src/serve/page-assets.mjs";

// The asset routes never read `home`, but the shared fixture builds an estate snapshot on
// start, so an empty runs/ has to exist.
const emptyHome = () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-desktop-assets-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  return home;
};

const withAssets = async (fn) => {
  const home = emptyHome();
  try {
    return await withServer({ home, cfg: cfg({ token: "s3cret" }) }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("pageHtml inlines desktop.css inside its one breakpoint, leaving no marker", () => {
  const page = pageHtml();
  assert.match(page, /@media \(min-width: 68\.75em\)/);
  assert.match(page, /--layout:\s*desktop/);
  assert.doesNotMatch(page, /\/\*@inline /);
});

test("desktop.js is served under the token, like perf.js", async () => {
  await withAssets(async ({ get }) => {
    const js = await get("/desktop.js?t=s3cret", { raw: true });
    assert.equal(js.status, 200);
    assert.match(js.body, /swarmDesktop/, "the file the page expects, not an empty 200");
    assert.equal((await get("/desktop.js")).status, 401, "the gate covers it too");
    const page = await get("/?t=s3cret", { raw: true });
    assert.equal(page.status, 200);
    assert.match(page.body, /@media \(min-width: 68\.75em\)/, "the served page carries the desktop rules");
  });
});

// One table serves all three, so a lost entry has to fail here rather than in a browser.
test("every lazy script the page boots is served, under the gate", async () => {
  const served = { "/perf.js": /window\.perfViews/, "/desktop.js": /swarmDesktop/, "/live.js": /window\.swarmLive/ };
  await withAssets(async ({ get }) => {
    for (const [path, marker] of Object.entries(served)) {
      const js = await get(`${path}?t=s3cret`, { raw: true });
      assert.equal(js.status, 200, path);
      assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8", path);
      assert.match(js.body, marker, `${path} must be its own file`);
      assert.equal((await get(path)).status, 401, `${path} behind the gate`);
    }
  });
});
