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
    usage("codex", [lim("codex primary", 0, { window: "5h" }), lim("codex secondary", 100, { window: "7d", resetsAt: "2026-09-26T09:00:00" })], { state: "exhausted" }),
  ],
  errors: {},
};
// The same payload with codex's dead allowance left out, for the reading tests.
const READABLE = { usages: LIVE.usages.slice(0, 2), errors: {} };
// Operator, 2026-09-24: "primary is weekly, secondary is session or vice versa" — the span decides.
test("codex primary/secondary land in Session and Week by their own window span", () => {
  const codex = { usages: [usage("codex", [lim("codex primary", 41, { window: "5h" }), lim("codex secondary", 6, { window: "7d" })])], errors: {} };
  assert.match(loadPerfViews().usageScreen(codex, H, "session"), /<b>59%<\/b>/, "the 5h window is the session");
  assert.match(loadPerfViews().usageScreen(codex, H, "week"), /<b>94%<\/b>/, "the 7d window is the week");
});
const pcards = (html) => html.match(/class="card upc[^"]*"/g) || [];

// Operator, 2026-09-24: the hero is where the next run goes — the MOST left, not the least.
test("the hero names the provider with the MOST left this session, as percent left", () => {
  const html = loadPerfViews().usageScreen(READABLE, H, "session");
  assert.match(html, /MOST LEFT THIS SESSION · ANTHROPIC/);
  assert.match(html, /class="uhero[^"]*"[\s\S]*?<b>97%<\/b>/, "3% used is 97% left");
});

test("Week reads anthropic's weekly_* buckets, the most-consumed one winning", () => {
  const html = loadPerfViews().usageScreen(READABLE, H, "week");
  assert.match(html, /MOST LEFT THIS WEEK · OLLAMA/);
  assert.match(html, /<b>72%<\/b>/, "ollama's plain weekly reads");
  assert.match(html, /class="nm">anthropic<\/span><span class="val bad">12%</, "weekly_all at 88% used beats weekly_scoped at 5%");
});

// Operator, 2026-09-24: alphabetical — the hero already carries the ranking.
test("one card per provider in alphabetical order, each with its percent left and a bar", () => {
  const html = loadPerfViews().usageScreen(LIVE, H, "session");
  assert.equal(pcards(html).length, 3);
  const order = [...html.matchAll(/class="nm">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ["anthropic", "codex", "ollama"]);
  assert.ok(html.includes("97%"));
});

// Operator, 2026-09-24: an exhausted provider is dead, and reads as such — never a blank card.
// Its note is when it comes back; 0% and red already say it ran out.
test("an exhausted provider reads 0% left in either window, noting when it resets", () => {
  for (const w of ["week", "session"]) {
    const html = loadPerfViews().usageScreen(LIVE, H, w);
    assert.equal((html.match(/class="card upc unread"/g) || []).length, 0, w);
    assert.match(html, /class="nm">codex<\/span><span class="val bad">0%</);
    assert.match(html, /class="nm">codex<\/span>[\s\S]*?<div class="sub">resets Sat 09:00<\/div>/);
    assert.ok(!html.includes("exhausted"), "0% in red already says it");
  }
});

// Operator, 2026-09-26: "When the codex session usage expires it takes out the weekly usage
// too" — "Real weekly left". A spent window zeroes its own tab and any SHORTER one, never a
// longer one: the spent 5h session says nothing about the week, and each tab still names its
// OWN window's reset.
test("a spent session window zeroes Session and leaves Week its own reading", () => {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Both windows get a distinct hour, so a tab showing the wrong limit's reset cannot pass.
  const at = (h) => {
    const d = new Date(Date.now() + h * 3_600_000);
    const pad = (n) => String(n).padStart(2, "0");
    return { iso: d.toISOString(), note: `resets ${DAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}` };
  };
  const sess = at(2), weekly = at(29);
  const codex = { usages: [usage("codex", [
    lim("codex primary", 100, { window: "5h", resetsAt: sess.iso }),
    lim("codex secondary", 44, { window: "7d", resetsAt: weekly.iso }),
  ], { state: "exhausted" })], errors: {} };
  const { usageScreen } = loadPerfViews();
  const week = usageScreen(codex, H, "week");
  assert.match(week, /class="nm">codex<\/span><span class="val ok">56%</, "44% used is 56% left");
  assert.match(week, new RegExp(`<div class="sub">${weekly.note}</div>`), "the weekly window's own reset, not the session's");
  const session = usageScreen(codex, H, "session");
  assert.match(session, /class="nm">codex<\/span><span class="val bad">0%</);
  assert.match(session, new RegExp(`<div class="sub">${sess.note}</div>`), "dead here, back when the session window is");
});

test("a provider that reports neither window, and is not exhausted, stays a dim card naming what it did report", () => {
  const html = loadPerfViews().usageScreen({ usages: [usage("codex", [lim("codex primary", 10, { window: "5h" })])] }, H, "week");
  assert.match(html, /not read — reports codex primary — no weekly window/);
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

// Operator, 2026-09-24: where a figure was read from is our plumbing, not the user's concern.
test("the card's note is the reset time alone — never where the figure was read from", () => {
  const at = new Date(Date.now() + 3_600_000);
  const html = loadPerfViews().usageScreen({ usages: [usage("ollama", [lim("session", 10, { resetsAt: at.toISOString() })], { provenance: "cache" })] }, H, "session");
  const hh = String(at.getHours()).padStart(2, "0");
  assert.match(html, new RegExp(`<div class="sub">resets \\w{3} ${hh}:\\d{2}</div>`));
  assert.ok(!html.includes("cache"));
});

// Operator, 2026-09-24: Week first, and the default.
test("the switch reads Week then Session, Week on when nothing is chosen", () => {
  const html = loadPerfViews().usageScreen(READABLE, H);
  assert.ok(html.includes('<div class="seg"><a data-href="#/usage/week" class="on">Week</a><a data-href="#/usage/session">Session</a></div>'));
  assert.match(html, /MOST LEFT THIS WEEK/);
});

test("with no provider in the payload it says how the screen fills", () => {
  assert.ok(loadPerfViews().usageScreen({ usages: [], errors: {} }, H, "session").includes("no provider answered"));
});

// The most-left provider is only the best of those read — an unread one may have more.
test("the hero names a provider that went unread", () => {
  const { usageScreen } = loadPerfViews();
  const html = usageScreen({ usages: [usage("ollama", [lim("session", 10)])], errors: { claude: "token expired" } }, H, "session");
  assert.ok(html.includes("claude not read"));
  const all = usageScreen({ usages: [usage("ollama", [lim("session", 10)])] }, H, "session");
  assert.ok(!all.includes("not read"));
});

// Operator 2026-09-24: "it should show the last value it is cached" … "And show e.g. [stale]" … "Chip".
test("a held-over reading keeps its figure and carries a stale chip; a live one does not", () => {
  const stale = { usages: [usage("anthropic", [lim("session", 40)], { provenance: "stale" }), READABLE.usages[1]], errors: {} };
  const html = loadPerfViews().usageScreen(stale, H, "session");
  assert.match(html, /anthropic<span class="chip warn stale">stale<\/span>[\s\S]*?60%/);
  assert.equal((html.match(/chip warn stale/g) || []).length, 1, "only the held-over provider is chipped");
});
