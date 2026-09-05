import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer, safeSegment } from "../src/serve/server.mjs";
import { RUN_LOG, NOW, buildFixture } from "./fixtures/run-fixture.mjs";

const cfg = (over = {}) => ({ quietWarnSecs: 60, dashboard: { port: 0, bind: "127.0.0.1", token: null, recentMs: 30 * 60_000, ...over } });

function seedHome() {
  const home = mkdtempSync(join(tmpdir(), "swarm-serve-"));
  const live = join(home, "runs", "C--code-a", "live-1");
  buildFixture(live);
  writeFileSync(join(live, "manifest.json"), JSON.stringify({ tasks: [{ id: "find-a", model: "m" }, { id: "find-b", model: "m" }, { id: "fix", model: "m", after: ["find-a"] }, { id: "review", model: "m", after: ["fix"] }] }), "utf8");
  writeFileSync(join(live, "results", "find-a.json"), JSON.stringify({ id: "find-a", model: "m", ok: true, output: "ten bullets", tokens: { input: 1, output: 2 }, numTurns: 7, prompt: "secret prompt" }), "utf8");
  writeFileSync(join(live, "results", "find-a.log"), "raw stream json — never served", "utf8");
  const done = join(home, "runs", "C--code-b", "done-1");
  buildFixture(done);
  writeFileSync(join(done, "summary.json"), JSON.stringify({ started: "2026-09-05T00:00:00Z", finished: "2026-09-05T00:30:00Z", tasks: [] }), "utf8");
  writeFileSync(join(done, "report.md"), "# Report\n\nPROVEN — a claim", "utf8");
  // Both logs get explicit stamps: the live one 5 s before NOW, the finished one an
  // hour earlier — otherwise the finished fixture carries the real clock and sorts first.
  const t = (NOW - 5000) / 1000;
  utimesSync(join(live, "run.log"), t, t);
  const td = (NOW - 3600_000) / 1000;
  utimesSync(join(done, "run.log"), td, td);
  return { home, live, done };
}

async function withServer(opts, fn) {
  const { home } = opts;
  const watchers = [];
  const _watch = (path, listener) => { const w = { path, listener, closed: false, close() { this.closed = true; } }; watchers.push(w); return w; };
  const server = createServer({ home, cfg: opts.cfg || cfg(), now: () => opts.now ?? NOW, _watch, _heartbeatMs: opts.heartbeatMs ?? 60_000, _debounceMs: 30 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const get = (path, { raw = false } = {}) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? body : tryJson(body) }));
    }).on("error", reject);
  });
  try { return await fn({ get, port, watchers, server }); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
const tryJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

test("safeSegment: ids with [ ] ~ . - pass; traversal, slashes, empties do not", () => {
  for (const ok of ["find-a", "fix[0]", "review~lint", "C--code-a", "run.1", "__digest"]) assert.ok(safeSegment(ok), ok);
  for (const bad of ["..", "../x", "a/b", "a\\b", "", ".", "a b", "%2e%2e", "C:"]) assert.ok(!safeSegment(bad), JSON.stringify(bad));
});

test("routes: runs list, run, leaf (no raw log, no prompt), digest fallback, manifest", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      const runs = await get("/api/runs");
      assert.equal(runs.status, 200);
      assert.deepEqual(runs.body.runs.map((r) => [r.project, r.name, r.active]), [["C--code-a", "live-1", true], ["C--code-b", "done-1", false]]);
      assert.equal(runs.body.runs[0].byState.running, 2, "list rows carry the state counts");

      const run = await get("/api/runs/C--code-a/live-1");
      assert.equal(run.status, 200);
      assert.equal(run.body.name, "live-1");
      assert.ok(Array.isArray(run.body.waves));
      assert.equal(run.body.quietWarnMs, 60_000);
      assert.equal(run.body.tasks.find((t) => t.id === "fix").depth, 1);

      const leaf = await get("/api/runs/C--code-a/live-1/leaves/find-a");
      assert.equal(leaf.status, 200);
      assert.equal(leaf.body.output, "ten bullets");
      assert.equal(leaf.body.numTurns, 7);
      assert.equal(leaf.body.prompt, undefined, "the prompt stays on disk");
      assert.equal(leaf.body.log, undefined);
      assert.equal((await get("/api/runs/C--code-a/live-1/leaves/nope")).status, 404);

      const digest = await get("/api/runs/C--code-a/live-1/digest", { raw: true });
      assert.equal(digest.status, 200);
      assert.match(digest.headers["content-type"], /text\/html/);
      assert.match(digest.body, /digest/);
      const report = await get("/api/runs/C--code-b/done-1/digest", { raw: true });
      assert.match(report.body, /Report/, "report.md wins over digest.md");
      rmSync(join(home, "runs", "C--code-b", "done-1", "report.md"));
      rmSync(join(home, "runs", "C--code-b", "done-1", "digest.md"));
      assert.equal((await get("/api/runs/C--code-b/done-1/digest")).status, 404);

      const manifest = await get("/manifest.webmanifest");
      assert.equal(manifest.status, 200);
      assert.equal(manifest.body.display, "standalone");
      assert.ok(manifest.body.icons.some((i) => i.sizes === "512x512" && i.type === "image/png"), "a 512 PNG for Android");
      const page = await get("/", { raw: true });
      assert.equal(page.status, 200);
      assert.match(page.body, /rel="apple-touch-icon"[^>]*icon-180\.png/, "iOS home-screen icon linked");
      assert.match(page.body, /id="rail"/, "the rail overlay is in the page");
      assert.equal((await get("/icon-999.png")).status, 404);
      assert.equal((await get("/api/runs/C--code-a/nope")).status, 404);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("runs list is per project: a busy project cannot crowd a quiet one off the estate", async () => {
  const { home } = seedHome();
  try {
    for (let i = 0; i < 12; i++) {
      const d = join(home, "runs", "C--code-busy", `old-${i}`);
      buildFixture(d);
      writeFileSync(join(d, "summary.json"), JSON.stringify({ finished: "2026-09-04T00:00:00Z", tasks: [] }), "utf8");
      const t = (NOW - 3600_000 * (i + 2)) / 1000;
      utimesSync(join(d, "run.log"), t, t);
    }
    await withServer({ home }, async ({ get }) => {
      const { body } = await get("/api/runs");
      const busy = body.runs.filter((r) => r.project === "C--code-busy");
      assert.equal(busy.length, 8, "capped per project");
      assert.ok(body.runs.some((r) => r.project === "C--code-b"), "the quiet project's finished run still listed");
      assert.ok(body.runs.some((r) => r.project === "C--code-a" && r.active), "live run always listed");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("path safety: every traversal shape is a 404 and never leaves the runs root", async () => {
  const { home } = seedHome();
  writeFileSync(join(home, "outside.json"), "{\"leak\":true}", "utf8");
  try {
    await withServer({ home }, async ({ get }) => {
      for (const p of [
        "/api/runs/../outside.json",
        "/api/runs/..%2F..%2Foutside.json",
        "/api/runs/C--code-a/..%2F..%2Foutside.json",
        "/api/runs/C--code-a/live-1/leaves/..%2F..%2F..%2Foutside",
        "/api/runs/C--code-a/live-1/leaves/%2e%2e",
        "/api/runs/C--code-a/live-1/leaves/a%5Cb",
        "/api/runs/C%3A/x",
      ]) {
        const r = await get(p);
        assert.equal(r.status, 404, p);
        assert.ok(!/leak/.test(JSON.stringify(r.body)), p);
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("token: when configured, every route needs ?t=; 401 without, 200 with", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home, cfg: cfg({ token: "s3cret" }) }, async ({ get }) => {
      assert.equal((await get("/api/runs")).status, 401);
      assert.equal((await get("/manifest.webmanifest")).status, 401);
      assert.equal((await get("/api/runs?t=wrong")).status, 401);
      assert.equal((await get("/api/runs?t=s3cret")).status, 200);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("events: SSE emits one debounced run event per burst, names the run, and heartbeats", async () => {
  const { home, live } = seedHome();
  try {
    await withServer({ home, heartbeatMs: 40 }, async ({ get, port, watchers }) => {
      const frames = [];
      const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        assert.match(res.headers["content-type"], /text\/event-stream/);
        res.setEncoding("utf8");
        res.on("data", (c) => frames.push(c));
      });
      await new Promise((r) => setTimeout(r, 60));
      const logWatcher = watchers.find((w) => w.path === join(live, "run.log"));
      assert.ok(logWatcher, "the active run's run.log is watched");
      logWatcher.listener("change", "run.log");
      logWatcher.listener("change", "run.log");
      await new Promise((r) => setTimeout(r, 120));
      req.destroy();
      const text = frames.join("");
      const runEvents = text.split("\n\n").filter((f) => /^event: run$/m.test(f));
      assert.equal(runEvents.length, 1, `one debounced event, got:\n${text}`);
      assert.match(runEvents[0], /"project":"C--code-a"/);
      assert.match(runEvents[0], /"name":"live-1"/);
      assert.match(text, /^: ping/m, "heartbeat comment present");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("events: a root change refreshes watchers so a new run gets watched", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ port, watchers }) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => { res.on("data", () => {}); });
      await new Promise((r) => setTimeout(r, 60));
      const fresh = join(home, "runs", "C--code-a", "live-2");
      buildFixture(fresh);
      const t = (NOW - 1000) / 1000;
      utimesSync(join(fresh, "run.log"), t, t);
      const root = watchers.find((w) => w.path === join(home, "runs"));
      assert.ok(root, "runs root watched");
      // fs.watch is not recursive: a new run under an EXISTING project is only seen
      // by that project dir's watcher, so one must exist.
      const proj = watchers.find((w) => w.path === join(home, "runs", "C--code-a"));
      assert.ok(proj, "each project dir is watched");
      proj.listener("rename", "live-2");
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(watchers.some((w) => w.path === join(fresh, "run.log")), "new active run is watched after a project-dir event");
      req.destroy();
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("icons: PNGs are real PNGs at the declared sizes, cached, and drawn (not a flat square)", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ port }) => {
      for (const size of [180, 192, 512]) {
        const buf = await new Promise((resolve, reject) => {
          http.get({ host: "127.0.0.1", port, path: `/icon-${size}.png` }, (res) => {
            assert.equal(res.statusCode, 200); assert.equal(res.headers["content-type"], "image/png");
            const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks)));
          }).on("error", reject);
        });
        assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
        assert.equal(buf.readUInt32BE(16), size, "IHDR width");
        assert.equal(buf.readUInt32BE(20), size, "IHDR height");
        assert.ok(buf.length > 500 && buf.length < 60_000, `plausible size for ${size}: ${buf.length}`);
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("perf: the score store ranked as scores.mjs ranks it — overall + every aspect, re-read when the file changes, bad aspect is a 400", async () => {
  const { home } = seedHome();
  try {
    const row = (leaf, model, grades, outcome = "completed") => JSON.stringify({ ts: "2026-09-05T00:00:00Z", resultsDir: "/r/x-1", leaf, model, effort: null, domain: "node", grades: { adherence: null, handoff: null, truthfulness: null, depth: null, discrimination: null, code: null, impl: null, search: null, web: null, vision: null, geometry: null, ...grades }, outcome, note: "", assessedBy: { session: "t" } });
    const path = join(home, "model-scores.jsonl");
    writeFileSync(path, [row("a", "m-good", { adherence: 9, handoff: 9, truthfulness: 9, depth: 9, code: 8 }), row("b", "m-thin", { adherence: 4, handoff: 5, truthfulness: 4, depth: 5 }), row("c", "m-thin", {}, "session-died")].join("\n") + "\n", "utf8");
    const { readRows, overall, aggregate } = await import("../src/scores.mjs");
    await withServer({ home, cfg: { ...cfg(), grading: { enabled: true } } }, async ({ get }) => {
      const p = await get("/api/perf");
      assert.equal(p.status, 200);
      assert.deepEqual(p.body.overall, overall(readRows(path)).cells, "overall is scores.mjs's ranking, untouched");
      assert.deepEqual(p.body.report, aggregate(readRows(path)).aspects, "every aspect table rides along");
      assert.equal(p.body.overall[0].model, "m-good");
      assert.deepEqual(p.body.domains, ["node"]);
      assert.equal(p.body.rows, 3);
      const one = await get("/api/perf?aspect=code&domain=node");
      assert.equal(one.body.report.length, 1); assert.equal(one.body.report[0].aspect, "code");
      assert.deepEqual(one.body.filters, { aspect: "code", model: null, domain: "node" });
      const m = await get("/api/perf?model=m-thin");
      assert.equal(m.body.overall.length, 1); assert.equal(m.body.overall[0].outcomes["session-died"], 1);
      assert.equal((await get("/api/perf?aspect=vibes")).status, 400);
      // A grade lands: the store's mtime moves and the next request sees the row.
      writeFileSync(path, readFileSync(path, "utf8") + row("d", "m-new", { adherence: 7, handoff: 7, truthfulness: 7, depth: 7 }) + "\n", "utf8");
      const t = (NOW + 60_000) / 1000; utimesSync(path, t, t);
      assert.equal((await get("/api/perf")).body.overall.length, 3);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("grading flag: /api/runs and /api/perf carry grading.enabled — false by default, true when the config says so", async () => {
  const { home } = seedHome();
  try {
    await withServer({ home }, async ({ get }) => {
      assert.equal((await get("/api/runs")).body.grading, false);
      const off = (await get("/api/perf")).body;
      assert.equal(off.grading, false);
      assert.equal(off.overall, undefined, "off serves no ranking");
      assert.equal(off.report, undefined, "off serves no aspect table");
    });
    await withServer({ home, cfg: { ...cfg(), grading: { enabled: true } } }, async ({ get }) => {
      assert.equal((await get("/api/runs")).body.grading, true);
      const on = (await get("/api/perf")).body;
      assert.equal(on.grading, true);
      assert.ok(Array.isArray(on.overall), "on serves the ranking");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
