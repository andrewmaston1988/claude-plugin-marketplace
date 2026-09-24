// The Usage screen's renderer, run for real through perf.js. A limit's `percent`
// is percent USED; every figure on screen is what is LEFT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPerfViews, H } from "./helpers/perf-views-harness.mjs";

const lim = (kind, percent, over = {}) => ({ kind, percent, resetsAt: null, scope: null, window: null, ...over });
const usage = (provider, limits, over = {}) => ({ provider, state: "ok", provenance: "live", limits, ...over });
const LIVE = {
  usages: [
    usage("anthropic", [lim("session", 3), lim("weekly_all", 88), lim("weekly_scoped", 5, { scope: "Fable" })]),
    usage("ollama", [lim("session", 37.1), lim("weekly", 28.3)]),
    usage("codex", [lim("codex primary", 0, { window: "5h" }), lim("codex secondary", 100, { window: "7d" })], { state: "exhausted" }),
  ],
  errors: {},
};
const pcards = (html) => html.match(/class="card upc[^"]*"/g) || [];

test("the hero names the provider with the LEAST left this session, as percent left", () => {
  const html = loadPerfViews().usageScreen(LIVE, H, "session");
  assert.match(html, /LOWEST THIS SESSION · OLLAMA/);
  assert.match(html, /class="uhero[^"]*"[\s\S]*?<b>63%<\/b>/, "37.1% used is 63% left");
});

test("Week reads anthropic's weekly_* buckets, the most-consumed one winning", () => {
  const html = loadPerfViews().usageScreen(LIVE, H, "week");
  assert.match(html, /LOWEST THIS WEEK · ANTHROPIC/);
  assert.match(html, /<b>12%<\/b>/, "weekly_all at 88% used beats weekly_scoped at 5%");
  assert.ok(html.includes("72%"), "ollama's plain weekly still reads");
});

test("one card per provider in payload order, each with its percent left and a bar", () => {
  const html = loadPerfViews().usageScreen(LIVE, H, "session");
  assert.equal(pcards(html).length, 3);
  const order = [...html.matchAll(/class="nm">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ["anthropic", "ollama", "codex"]);
  assert.ok(html.includes("97%"));
});

test("codex's primary/secondary are never relabelled — a dim card names what it did report, and that it is exhausted", () => {
  const html = loadPerfViews().usageScreen(LIVE, H, "week");
  assert.equal((html.match(/class="card upc unread"/g) || []).length, 1);
  assert.match(html, /not read — reports codex primary, codex secondary — no weekly window · exhausted/);
});

test("a provider whose read failed keeps its card, naming the error", () => {
  const html = loadPerfViews().usageScreen({ usages: [], errors: { claude: "token expired" } }, H, "session");
  assert.equal(pcards(html).length, 1);
  assert.ok(html.includes("not read — token expired"));
  assert.ok(!html.includes("uhero"), "no reading, no hero");
});

test("bands: 20 or less left is bad, 40 or less warn, else ok", () => {
  const { usageScreen } = loadPerfViews();
  const tone = (used) => usageScreen({ usages: [usage("p", [lim("session", used)])] }, H, "session").match(/class="card upc (\w+)"/)[1];
  assert.equal(tone(80), "bad");
  assert.equal(tone(60), "warn");
  assert.equal(tone(59), "ok");
});

test("a reset time and a non-live provenance ride in the card's note", () => {
  const at = new Date(Date.now() + 3_600_000);
  const html = loadPerfViews().usageScreen({ usages: [usage("ollama", [lim("session", 10, { resetsAt: at.toISOString() })], { provenance: "cache" })] }, H, "session");
  const hh = String(at.getHours()).padStart(2, "0");
  assert.match(html, new RegExp(`resets \\w{3} ${hh}:\\d{2} · read from cache`));
});

test("the Session/Week switch marks the chosen window", () => {
  const html = loadPerfViews().usageScreen(LIVE, H, "week");
  assert.match(html, /class="ctab on" data-usage-window="week"/);
  assert.match(html, /class="ctab" data-usage-window="session"/);
});

test("with no provider in the payload it says how the screen fills", () => {
  assert.ok(loadPerfViews().usageScreen({ usages: [], errors: {} }, H, "session").includes("no provider answered"));
});

test("the hero never claims headroom across EVERY provider while one went unread", () => {
  const { usageScreen } = loadPerfViews();
  const html = usageScreen(LIVE, H, "session");
  assert.ok(!html.includes("across every provider"), "codex was not read, and is exhausted");
  assert.ok(html.includes("codex not read"));
  const all = usageScreen({ usages: [usage("ollama", [lim("session", 10)])] }, H, "session");
  assert.ok(all.includes("across every provider"));
});
