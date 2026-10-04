import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seedHome, withServer } from "./helpers/serve-fixture.mjs";

// The run's two documents, digest and report, each behind its own route.

test("/digest renders the digest; report.md never stands in for it", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const digest = await get("/api/runs/C--code-a/live-1/digest", { raw: true });
      assert.equal(digest.status, 200);
      assert.match(digest.headers["content-type"], /text\/html/);
      assert.match(digest.body, /digest/);
      // The digest is the digest: report.md is never substituted for it — two documents, never one.
      writeFileSync(join(home, "runs", "C--code-b", "done-1", "digest.md"), "# Digest\n\nDIGESTMARKER", "utf8");
      const both = await get("/api/runs/C--code-b/done-1/digest", { raw: true });
      assert.equal(both.status, 200);
      assert.match(both.body, /DIGESTMARKER/, "the digest is what is rendered");
      assert.ok(!/PROVEN/.test(both.body), "report.md must not stand in for the digest");
      rmSync(join(home, "runs", "C--code-b", "done-1", "report.md"));
      rmSync(join(home, "runs", "C--code-b", "done-1", "digest.md"));
      assert.equal((await get("/api/runs/C--code-b/done-1/digest")).status, 404, "neither document → 404, never a report fallback");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/digest serves digest.html as written when the run wrote one — the render is the fallback", async () => {
  const { home } = seedHome();
  try {
    // A bare `#` inside the body is a markdown h1 mdToHtml would mangle, so serving
    // it byte-for-byte proves the file itself went out.
    const body = "<html><body><p># not a heading</p></body></html>";
    writeFileSync(join(home, "runs", "C--code-a", "live-1", "digest.html"), body, "utf8");
    await withServer({ home }, async ({ get }) => {
      const r = await get("/api/runs/C--code-a/live-1/digest", { raw: true });
      assert.equal(r.status, 200);
      assert.match(r.headers["content-type"], /text\/html/);
      assert.equal(r.body, body, "already HTML — served as written, not re-rendered");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/report renders report.md for a run that never wrote report.html — an old run still opens", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const r = await get("/api/runs/C--code-b/done-1/report", { raw: true });
      assert.equal(r.status, 200, "a run with only report.md still reaches its report");
      assert.match(r.headers["content-type"], /text\/html/);
      assert.match(r.body, /PROVEN/, "report.md is rendered for the page");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
