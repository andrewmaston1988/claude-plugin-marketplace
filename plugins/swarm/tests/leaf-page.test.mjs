// The leaf page as one feature: a status banner stating the leaf's single most useful
// fact, then its chips, then three cards — position in the graph, tokens, prompt/output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE, RUN_URL, targetRun, loadPage } from "./helpers/page-harness.mjs";

const LEAF_URL = `${RUN_URL}/leaf/impl`;

const paintLeaf = async (task, { tasks = [], leaf = {}, run = {} } = {}) => {
  const P = loadPage();
  await P.flush();
  P.location.hash = LEAF_URL;
  P.fireHashchange();
  await P.flush();
  const all = [{ id: "impl", model: "glm", tokens: { input: 10, output: 20 }, after: [], ...task }, ...tasks];
  P.respondRun({ ...targetRun(), tasks: all, waves: [all.map((t) => t.id)], ...run });
  P.respondLeaf({ id: "impl", prompt: "do it", output: "done", ...leaf });
  await P.flush();
  return P;
};

const bannerOf = async (task, opts) => {
  const P = await paintLeaf(task, opts);
  const b = P.findByClass("banner");
  assert.equal(b.length, 1, "exactly one banner — the leaf's single verdict");
  return { tone: b[0].getAttribute("class"), text: P.screenText(), P };
};

// ── the banner: one tone per state, and a fact in every one ──────────────

test("a finished leaf banners green with how long it took", async () => {
  const { tone, text } = await bannerOf({ state: "ok", durationMs: 125_000 });
  assert.match(tone, /\bok\b/);
  assert.ok(text.includes("Finished clean in 02:05"), "states the duration, not just 'done'");
});

test("a failed leaf banners red, whatever its failure flavour", async () => {
  for (const state of ["failed", "failed:timeout", "blocked"]) {
    const { tone } = await bannerOf({ state });
    assert.match(tone, /\bbad\b/, `${state} is a failure tone`);
  }
});

test("a timed-out leaf says it timed out, not just that it failed", async () => {
  const { text } = await bannerOf({ state: "failed:timeout" });
  assert.ok(text.includes("Timed out"));
});

test("a running leaf past the quiet threshold banners amber with the quiet stretch", async () => {
  const { tone, text } = await bannerOf({ state: "running", startedMs: Date.now() - 900_000, lastEventMs: Date.now() - 600_000 });
  assert.match(tone, /\bslow\b/);
  assert.ok(text.includes("No output for 10:00"), "names how long it has been quiet");
});

test("a running leaf inside the threshold banners purple with its elapsed time", async () => {
  const { tone, text } = await bannerOf({ state: "running", startedMs: Date.now() - 30_000, lastEventMs: Date.now() - 1000 });
  assert.doesNotMatch(tone, /\b(ok|slow|bad|queued)\b/, "the base tone is the running one");
  assert.ok(text.includes("Running for"));
});

test("a pending leaf banners grey and names what it is waiting on", async () => {
  const { tone, text } = await bannerOf({ state: "pending", after: ["survey"] }, { tasks: [{ id: "survey", state: "running", after: [] }] });
  assert.match(tone, /\bqueued\b/);
  assert.ok(text.includes("Starts when survey finishes"));
});

test("the queued tone carries its own fills, so it is not the running purple by default", () => {
  assert.match(readFileSync(PAGE, "utf8"), /\.banner\.queued\s*\{[^}]*--bn-bg:/);
});

// ── the three cards ──────────────────────────────────────────────────────

test("the position card names what the leaf waited on and what it feeds, and links back to the tree", async () => {
  const P = await paintLeaf({ state: "ok", after: ["survey"] }, {
    tasks: [{ id: "survey", state: "ok", after: [] }, { id: "review", state: "pending", after: ["impl"] }],
  });
  const cards = P.findByClass("card");
  assert.equal(cards.length, 3, "position, tokens, prompt/output");
  const pos = cards[0].textContent;
  assert.ok(pos.includes("survey") && pos.includes("review"), "after and feeds both shown");
  const back = P.findByClass("show")[0];
  assert.equal(back.getAttribute("data-href"), RUN_URL, "Show in tree returns to the run");
});

test("the tokens card splits into billed input, output and cache read, and says so", async () => {
  const P = await paintLeaf({ state: "ok", tokens: { input: 10, cacheCreation: 990, output: 500, cacheRead: 4000 } });
  const segs = P.findByClass("segbar")[0].childNodes.filter((n) => n.nodeType === 1);
  assert.equal(segs.length, 3, "three segments");
  assert.deepEqual(segs.map((s) => s.getAttribute("style").match(/flex:(\d+)/)[1]), ["1000", "500", "4000"],
    "input is input + cacheCreation — what the CLI reports as input");
  const text = P.screenText();
  assert.ok(text.includes("Input 1k") && text.includes("Output 500") && text.includes("Cache 4k"));
});

test("prompt and output are two disclosure rows, both collapsed on arrival", async () => {
  const P = await paintLeaf({ state: "ok" });
  assert.equal(P.findByClass("disc").length, 2);
  assert.ok(!P.screenText().includes("do it"), "the prompt body stays folded until tapped");
});

test("every card is the same surface: 1px border, radius 14", () => {
  const css = readFileSync(PAGE, "utf8").match(/\.card\s*\{([^}]*)\}/);
  assert.ok(css, ".card must carry its own rule");
  assert.match(css[1], /border:\s*1px solid/);
  assert.match(css[1], /border-radius:\s*14px/);
});

// A live tick from an Ollama leaf carries the whole prompt as input_tokens and
// output_tokens:0, with no cache field — the split only exists in the final result.
// Drawing it live painted Output 0 / Cache 0 on every running leaf.
test("a running leaf whose ticks carry no split shows the total and says the split comes at the end", async () => {
  const P = await paintLeaf({ state: "running", startedMs: Date.now() - 30_000, lastEventMs: Date.now(), tokens: { input: 6_707_164, output: 0, cacheCreation: 0, cacheRead: 0 } });
  assert.equal(P.findByClass("segbar").length, 0, "no bar drawn from a split that does not exist yet");
  const text = P.screenText();
  assert.ok(!text.includes("Output 0"), "never claims zero output mid-run");
  assert.ok(text.includes("6.7M") && text.includes("split arrives when the leaf finishes"));
});

test("a running leaf whose ticks DO carry output still draws the split", async () => {
  const P = await paintLeaf({ state: "running", startedMs: Date.now() - 30_000, lastEventMs: Date.now(), tokens: { input: 100, cacheCreation: 900, output: 50, cacheRead: 3000 } });
  assert.equal(P.findByClass("segbar").length, 1);
});

test("the activity line stays on one line and ellipsises rather than wrapping", async () => {
  const P = await paintLeaf({ state: "running", startedMs: Date.now() - 30_000, lastEventMs: Date.now(), activity: "Bash rm -rf src/stonk/__pycache__ && PYTHONP…" });
  assert.equal(P.findByClass("act").length, 1, "the activity text is its own element");
  const css = readFileSync(PAGE, "utf8").match(/\.card \.act\s*\{([^}]*)\}/);
  assert.ok(css, ".act carries its own rule");
  assert.match(css[1], /white-space:\s*nowrap/);
  assert.match(css[1], /text-overflow:\s*ellipsis/);
  assert.match(css[1], /overflow:\s*hidden/);
  assert.match(css[1], /min-width:\s*0/, "a flex child without min-width:0 refuses to shrink, so it never ellipsises");
});

test("a running leaf's banner carries the run tree's spinner in its status circle", async () => {
  const { P } = await bannerOf({ state: "running", startedMs: Date.now() - 30_000, lastEventMs: Date.now() });
  const ic = P.findByClass("ic")[0];
  const ring = [];
  (function walk(n) { if (n.nodeType !== 1) return; if ((n.getAttribute("class") || "").split(/\s+/).includes("ring")) ring.push(n); n.childNodes.forEach(walk); })(ic);
  assert.equal(ring.length, 1, "the same .ring element the tree animates, inside the circle");
});

// "Show in tree" used to be a bare link to the run: it landed at the top of the tree with
// nothing marking which row the leaf was. It must land ON the leaf — its wave opened and
// its row flashed — so the tap answers "where is this leaf?".
const tapShow = (P) => {
  const show = P.findByClass("show")[0];
  const target = { dataset: { href: show.getAttribute("data-href"), focus: show.getAttribute("data-focus") }, classList: { contains: () => false } };
  P.main.contains = () => true;
  P.main.listeners.click.forEach((f) => f({ target: { closest: () => target } }));
};

test("Show in tree lands on the leaf's own row, flashed, with its wave opened", async () => {
  const tasks = [{ id: "survey", state: "ok", after: [] }];
  const P = await paintLeaf({ state: "ok", after: ["survey"] }, { tasks });
  tapShow(P);
  assert.equal(P.location.hash, RUN_URL, "still navigates to the run");
  P.fireHashchange();
  await P.flush();
  P.respondRun({ ...targetRun(), tasks: [{ id: "survey", state: "ok", after: [] }, { id: "impl", state: "ok", model: "glm", tokens: { input: 1, output: 1 }, after: ["survey"] }], waves: [["survey"], ["impl"]] });
  await P.flush();
  const flashed = P.findByClass("flash");
  assert.equal(flashed.length, 1, "exactly one row is marked");
  assert.equal(flashed[0].getAttribute("data-node"), "impl", "and it is the leaf we came from");
});

test("Show in tree opens a wave the operator had closed, so the leaf's row exists to land on", async () => {
  const P = await paintLeaf({ state: "ok", after: ["survey"] }, { tasks: [{ id: "survey", state: "ok", after: [] }] });
  // close wave 2 (index 1) the way the wave label's tap does
  P.main.contains = () => true;
  const waveTap = { dataset: { wave: "1" }, classList: { contains: (c) => c === "wave-label" } };
  P.main.listeners.click.forEach((f) => f({ target: { closest: () => waveTap } }));
  tapShow(P);
  P.fireHashchange();
  await P.flush();
  P.respondRun({ ...targetRun(), tasks: [{ id: "survey", state: "ok", after: [] }, { id: "impl", state: "ok", model: "glm", tokens: { input: 1, output: 1 }, after: ["survey"] }], waves: [["survey"], ["impl"]] });
  await P.flush();
  assert.equal(P.findByClass("flash").map((e) => e.getAttribute("data-node")).join(), "impl");
});
