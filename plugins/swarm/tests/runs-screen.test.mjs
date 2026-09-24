// The runs screen in the leaf/Usage flavour: live runs are cards, the header names
// the screen and carries a live pill; finished stacks stay compact rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, listData, listRow } from "./helpers/page-harness.mjs";

async function runsWith(data) {
  const P = loadPage();
  await P.flush();
  P.respondList(data);
  await P.flush();
  return P;
}

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

// Operator 2026-09-24: "does it duplicate the token count" — the per-provider split
// replaces the total, never sits beside it.
test("a run's tokens read once: the provider split when there is one, else the total", async () => {
  const one = await runsWith(listData(listRow({ tokens: 12_000, providerTokens: { ollama: 12_000 } })));
  assert.equal(one.findByClass("rs")[0].textContent.match(/12k/g).length, 1);
  assert.match(one.findByClass("rs")[0].textContent, /ollama 12k/);
  const none = await runsWith(listData(listRow({ tokens: 12_000 })));
  assert.match(none.findByClass("rs")[0].textContent, /12k/);
});

// Operator 2026-09-24: "the pulse is only applied on one screen" — the rule keys on the
// ring, so every running glyph pulses, not only the runs card.
test("the pulse applies to the dot under every spinning ring", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/serve/page.html", import.meta.url), "utf8");
  assert.match(css, /circle:has\(\+ \.ring\)\s*\{\s*animation:pulse/);
  assert.doesNotMatch(css, /\.rspin circle:not\(\.ring\)/);
});
