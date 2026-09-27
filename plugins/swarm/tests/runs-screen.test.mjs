// The runs screen in the leaf/Usage flavour: live runs are cards, the header names
// the screen and carries a live pill; finished stacks stay compact rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow, RUN_URL, targetRun } from "./helpers/page-harness.mjs";

async function runsWith(data) {
  const P = loadPage();
  await P.flush();
  P.respondList(data);
  await P.flush();
  return P;
}

// ── coverage: a short mustRead is a warning on both screens ──────────────────
// The engine records a shortfall and never fails the leaf (`scheduler.mjs` finish), so
// the state alone cannot tell a leaf that read what it was asked from one that did not.
// A codex leaf reporting "3 of 430 required lines" reached the operator as "complete".

const SHORT = { status: "incomplete", required: 430, read: 3, missed: ["README.md"] };
const leafTask = (coverage, over = {}) => ({ ...targetRun().tasks[0], ...(coverage ? { coverage } : {}), ...over });
const runWith = (coverage) => ({ ...targetRun(), tasks: [leafTask(coverage)] });

async function openRun(run) {
  const P = loadPage();
  await P.flush();
  P.location.hash = RUN_URL;
  P.fireHashchange();
  await P.flush();
  P.respondRun(run);
  await P.flush();
  return P;
}

async function openLeaf(leaf) {
  const P = loadPage();
  await P.flush();
  P.location.hash = `${RUN_URL}/leaf/leaf-a`;
  P.fireHashchange();
  await P.flush();
  P.respondRun(runWith(null));
  P.respondLeaf({ id: "leaf-a", prompt: "do it", output: "done", ...leaf });
  await P.flush();
  return P;
}

test("run screen: a leaf whose read was short is marked on its row, and a clean one is not", async () => {
  const warned = await openRun(runWith(SHORT));
  const marks = warned.findByClass("covwarn");
  assert.equal(marks.length, 1, "the row carries the warning");
  assert.match(marks[0].textContent, /3 of 430/, "and names the shortfall, not just that something is off");
  const clean = await openRun(runWith({ status: "complete", required: 430, read: 430 }));
  assert.equal(clean.findByClass("covwarn").length, 0, "a complete read is the clean case");
});

test("leaf screen: a short read banners amber instead of the clean green, naming the shortfall", async () => {
  const P = await openLeaf({ coverage: SHORT });
  const b = P.findByClass("banner");
  assert.equal(b.length, 1);
  assert.match(b[0].getAttribute("class"), /\bslow\b/, "the ok/clean green is exactly what the operator was shown");
  assert.doesNotMatch(b[0].getAttribute("class"), /\bok\b/);
  assert.match(P.screenText(), /3 of 430/);
});

test("leaf screen: an unparseable transcript warns as its own fact, not as a partial read", async () => {
  const P = await openLeaf({ coverage: { status: "unparseable", required: 12, read: 0, missed: [] } });
  const text = P.screenText();
  assert.match(P.findByClass("banner")[0].getAttribute("class"), /\bslow\b/);
  assert.match(text, /could not be read/, "the cause is named — 0 of 12 reads the same either way");
});

test("leaf screen: a leaf with no coverage recorded keeps the clean banner", async () => {
  const P = await openLeaf({});
  const b = P.findByClass("banner")[0];
  assert.match(b.getAttribute("class"), /\bok\b/);
  assert.equal(P.findByClass("covwarn").length, 0);
});

test("a live run is a card carrying its name, elapsed time and progress bar", async () => {
  const P = await runsWith(listData(listRow()));
  const cards = P.findByClass("rcard");
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /LISTRUN/);
  assert.equal(cards[0].getAttribute("data-href"), "#/run/C--code-listproj/LISTRUN");
  assert.equal(P.findByClass("rbar").length, 1);
  assert.equal(P.findByClass("row").length, 0, "no rail row for a live run");
});

test("the header names the screen and counts live runs in a pill", async () => {
  const P = await runsWith(listData(listRow()));
  assert.match(P.hdr.textContent, /swarm/);
  assert.match(P.hdr.textContent, /1 live/);
});

test("with nothing running there is no live pill", async () => {
  const done = listRow({ active: false, finishedMs: Date.now(), byState: { ok: 1 } });
  const P = await runsWith({ ...listData(done), finishedTotals: { "C--code-listproj": 1 } });
  assert.doesNotMatch(P.hdr.textContent, /live/);
  assert.equal(P.findByClass("rcard").length, 0);
});

// Operator 2026-09-24: "dislike the pulsing purple dot, keep the spinning one from other screens".
test("a running card carries the spinning ring, not a pulsing dot", async () => {
  const P = await runsWith(listData(listRow()));
  assert.equal(P.findByClass("rspin").length, 1);
  assert.equal(P.findByClass("ring").length, 1);
  assert.equal(P.findByClass("rdot").length, 0);
});

// A run's tokens read once, as its total: the per-provider split is gone, not hidden,
// and the providers become a chip stack instead.
test("a run's tokens read once, as the run total, with no per-provider figure", async () => {
  const P = await runsWith(listData(listRow({ tokens: 12_000, providerTokens: { ollama: 9_000, claude: 3_000 } })));
  const rs = P.findByClass("rs")[0].textContent;
  assert.match(rs, /12k/);
  assert.equal(rs.match(/12k/g).length, 1, "the total appears once");
  assert.doesNotMatch(rs, /ollama|claude/, "no provider figure survives in the meta line");
  const none = await runsWith(listData(listRow({ tokens: 12_000 })));
  assert.match(none.findByClass("rs")[0].textContent, /12k/);
});

// The stack is one chip per provider, largest tokens first, each chip naming its
// provider for the screen reader (the provider text itself is gone from the tile).
const chipsOf = (P, root) => P.findByClass("pitem", root).map((c) => ({
  cls: c.getAttribute("class"),
  label: c.children[0].getAttribute("aria-label"),
  z: Number((/z-index:(-?\d+)/.exec(c.getAttribute("style")) || [])[1]),
  style: c.getAttribute("style"),
}));

test("the chip stack follows the swarm name, in token order", async () => {
  const P = await runsWith(listData(listRow({ tokens: 1_201_000, providerTokens: { ollama: 300_000, claude: 900_000, unknown: 1000 } })));
  const card = P.findByClass("rcard")[0];
  const rh = P.findByClass("rh", card)[0];
  const chips = chipsOf(P, card);
  assert.equal(chips.length, 2, "one chip per known provider, nothing for the unknown bucket");
  assert.deepEqual(chips.map((c) => c.label), ["claude", "ollama"], "largest provider first");
  assert.ok(chips[0].z > chips[1].z, "the leading chip is drawn in front");
  const name = rh.children.findIndex((n) => n.getAttribute("class") === "nm");
  assert.equal(rh.children[name + 1].getAttribute("class"), "pstack", "the stack sits directly after the name");
});

test("a provider with no logo gets an initial chip, so no provider disappears silently", async () => {
  const P = await runsWith(listData(listRow({ tokens: 100, providerTokens: { mystery: 100 } })));
  const chips = chipsOf(P, P.findByClass("rcard")[0]);
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, "mystery");
  assert.equal(P.findByClass("pitem")[0].textContent.trim(), "M");
});

// A live stack: providers with a running leaf pulse in front; idle ones sit dim behind.
test("a live run's running provider is solid and pulsing in front, the idle one dim behind", async () => {
  const P = await runsWith(listData(listRow({ tokens: 12_000, providerTokens: { ollama: 300_000, claude: 40_000 }, providersRunning: ["claude"] })));
  const chips = chipsOf(P, P.findByClass("rcard")[0]);
  assert.deepEqual(chips.map((c) => c.cls), ["pitem pulse", "pitem dim"], "active pulses, idle dims");
  assert.deepEqual(chips.map((c) => c.label), ["claude", "ollama"], "the running provider leads, despite the smaller token count");
  assert.ok(chips[0].z > chips[1].z, "the active chip is in front");
  assert.match(chips[0].style, /animation-delay:0s/);
});

// A finished run's discs are at rest (no per-disc dim or pulse; the stack dims as a
// group in CSS), in token order, the largest on top, and the row reads the run total.
test("a finished run's chips are at rest, in token order, the largest drawn on top", async () => {
  const done = listRow({ active: false, finishedMs: Date.now(), byState: { ok: 1 }, tokens: 12_000, providerTokens: { ollama: 300_000, claude: 900_000 }, providersRunning: ["ollama"] });
  const data = { ...listData(done), finishedTotals: { "C--code-listproj": 1 } };
  const P = await runsWith(data);
  // A project's finished stack is collapsed until it is opened (page.html's (d)).
  P.tap(P.findByClass("section").find((e) => e.getAttribute("data-project")));
  await P.flush();
  P.respondList(data);
  await P.flush();
  const chips = chipsOf(P, P.main);
  assert.deepEqual(chips.map((c) => c.cls), ["pitem", "pitem"], "no dim and no pulse once the run is done");
  assert.deepEqual(chips.map((c) => c.label), ["claude", "ollama"]);
  assert.ok(chips[0].z > chips[1].z, "the largest is drawn on top");
  assert.doesNotMatch(chips[0].style, /animation-delay/);
  assert.match(P.findByClass("meta", P.main).map((e) => e.textContent).join(" "), /12k/, "the finished row reads the run total");
});

// The stagger is set on .pitem but the animation runs on .pdisc; delay does not inherit.
test("the pulsing disc takes its stagger from its chip", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/serve/page.html", import.meta.url), "utf8");
  assert.match(css, /\.pitem\.pulse \.pdisc\s*\{[^}]*animation:chipPulse[^}]*;\s*animation-delay:inherit;/);
});

test("the chip pulse is off under prefers-reduced-motion", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/serve/page.html", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.pitem\.pulse \.pdisc\s*\{\s*animation:none/);
});

// Operator 2026-09-24: "the pulse is only applied on one screen" — the rule keys on the
// ring, so every running glyph pulses, not only the runs card.
test("the pulse applies to the dot under every spinning ring", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/serve/page.html", import.meta.url), "utf8");
  assert.match(css, /circle:has\(\+ \.ring\)\s*\{\s*animation:pulse/);
  assert.doesNotMatch(css, /\.rspin circle:not\(\.ring\)/);
});
