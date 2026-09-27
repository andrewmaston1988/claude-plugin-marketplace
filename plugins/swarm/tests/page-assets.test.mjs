// pageHtml() is the page both the server and the harness boot: markers become the
// named asset's text, and an asset that would close its inline element is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageHtml } from "../src/serve/page-assets.mjs";

test("pageHtml: an inline marker is replaced by the named asset's contents", () => {
  const live = readFileSync(new URL("../src/serve/live.js", import.meta.url), "utf8");
  assert.equal(pageHtml("<script>/*@inline live.js*/</script>"), `<script>${live}</script>`);
});

test("pageHtml: an asset holding a closing </script> is refused, not inlined", () => {
  // page.html itself closes its own <script>, so inlining it must throw.
  assert.throws(() => pageHtml("<script>/*@inline page.html*/</script>"), /cannot be inlined/);
});
