import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { seedHome, withServer } from "./helpers/serve-fixture.mjs";

test("install surface: manifest, icons and the iOS touch icon", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const manifest = await get("/manifest.webmanifest");
      assert.equal(manifest.status, 200);
      assert.equal(manifest.body.display, "standalone");
      assert.deepEqual(manifest.body.launch_handler, { client_mode: "navigate-existing" }, "a link opens in the installed window, not a new one");
      assert.ok(manifest.body.icons.some((i) => i.sizes === "512x512" && i.type === "image/png"), "a 512 PNG for Android");
      const page = await get("/", { raw: true });
      assert.match(page.body, /rel="apple-touch-icon"[^>]*icon-180\.png/, "iOS home-screen icon linked");
      assert.equal((await get("/icon-999.png")).status, 404);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
