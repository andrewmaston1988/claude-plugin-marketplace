// The report.md → report.html renderer. A MECHANICAL projection of the markdown:
// standard md → html PLUS five semantic upgrades (verdict badges, operator-feel
// chip, path:line citations, coverage callout, provenance strip) and a synthesised
// confidence tally. These tests pin the LOAD-BEARING failure modes the plan names —
// HTML-injection, badge-word-in-prose, path:line-in-a-fence, malformed input — and
// the upgrades themselves.
import { test } from "node:test";
import { ok, match, doesNotMatch } from "node:assert/strict";
import { mdToHtml } from "../src/md_to_html.mjs";

// ── failure modes (the load-bearing ones) ──────────────────────────────

test("escapes HTML from model output — a leaf that writes <script> does not ship it", () => {
  const html = mdToHtml("# Title\n\nA finding: <script>alert(1)</script> and a<b>c.\n");
  ok(!html.includes("<script>alert(1)</script>"), "raw <script> must not survive");
  ok(html.includes("&lt;script&gt;"), "angle brackets must be entity-escaped");
  ok(html.includes("a&lt;b&gt;c"), "inline < > in prose escaped too");
});

test("a badge word inside prose is NOT a badge — only a ledger row leading with it", () => {
  const html = mdToHtml("# T\n\nThe claim is proven correct and the OPEN door stayed open.\n");
  doesNotMatch(html, /class="badge/, "mid-sentence verdict words must stay plain text");
});

test("a verdict word LEADING a ledger row renders as a coloured badge", () => {
  const html = mdToHtml("# T\n\n## PROVEN / OPEN ledger\n\n**OPEN**\n\n- **REFUTED** the citation was invalid\n- **OVERCLAIM** uncited prose\n");
  match(html, /class="badge b-refuted"/);
  match(html, /class="badge b-overclaim"/);
});

test("a path:line inside a fenced code block is code, not a citation", () => {
  const html = mdToHtml("# T\n\n```\nif err: log(foo.gd:42)\n```\n");
  doesNotMatch(html, /class="cite"/, "citations must not be upgraded inside code fences");
  ok(html.includes("foo.gd:42"), "the text is preserved verbatim in the code block");
});

test("a malformed report missing ledger and footnote still renders, does not throw", () => {
  const html = mdToHtml("# Just a title\n\nOne paragraph, no ledger, no run footnote.\n");
  match(html, /<h1[^>]*class="title"/);
  ok(html.includes("One paragraph"));
});

test("empty / whitespace-only input renders a valid document without throwing", () => {
  const html = mdToHtml("   \n\n");
  match(html, /<!doctype html>/i);
  match(html, /<\/html>/);
});

test("legible in BOTH themes — light + dark are designed, not inverted", () => {
  const html = mdToHtml("# T\n\ntext\n");
  match(html, /prefers-color-scheme: dark/);
  match(html, /\[data-theme="dark"\]/);
  match(html, /\[data-theme="light"\]/);
});

// ── the semantic upgrades ──────────────────────────────────────────────

test("a path:line citation in prose becomes a monospace citation span", () => {
  const html = mdToHtml("# T\n\nThe resolver at crafting.gd:75 reads only tools.\n");
  match(html, /class="cite">crafting\.gd:75<\/(cite|span)>/);
});

test("operator-feel, unresolved becomes an amber playtest chip", () => {
  const html = mdToHtml("# T\n\nDo recipes need two skills? operator-feel, unresolved\n");
  match(html, /class="feel"/);
});

test("a NOT-covered / NOT-seen warning line becomes a callout box", () => {
  const html = mdToHtml("# T\n\n⚠ verify saw only 4,000 of 9,120 chars — the remainder is NOT covered.\n");
  match(html, /class="callout"/);
});

test("the *Run:* footnote becomes a provenance strip of leaf chips", () => {
  const html = mdToHtml("# T\n\nbody\n\n---\n*Run: pz glm-5.2 (12m) · ours minimax-m3 (3m) · verify kimi (6m) · digest glm-5.2 (5m)*\n");
  match(html, /class="prov"/);
  match(html, /class="leaf"/);
  ok(html.includes("pz"), "each leaf name appears in the strip");
  ok(html.includes("verify"));
});

test("the confidence tally is synthesised by COUNTING verdict badges", () => {
  const md = "# T\n\n## PROVEN / OPEN ledger\n\n**PROVEN**\n\n- **PROVEN** a\n- **PROVEN** b\n\n**OPEN**\n\n- **OPEN** c\n- **REFUTED** d\n";
  const html = mdToHtml(md);
  match(html, /class="tally-bar"/);
  match(html, /class="tally-legend"/);
  // 2 proven, 1 open, 1 refuted counted from the ledger badges
  match(html, /<b>2<\/b>&nbsp;proven/);
  match(html, /<b>1<\/b>&nbsp;open/);
  match(html, /<b>1<\/b>&nbsp;refuted/);
});

test("no verdict badges anywhere → no tally hero is emitted", () => {
  const html = mdToHtml("# T\n\nA plain report with no graded claims.\n");
  doesNotMatch(html, /class="tally-bar"/);
});

// ── the two-track ledger (the signature) ────────────────────────────────

test("the PROVEN / OPEN ledger renders as a two-track board", () => {
  const md = "# T\n\n## PROVEN / OPEN ledger\n\n**PROVEN** (verifier-confirmed):\n- Fact one — foo.gd:1\n- Fact two — bar.gd:2\n\n**OPEN** (unverified):\n- Claim three uncited\n";
  const html = mdToHtml(md);
  match(html, /class="track settled"/);
  match(html, /class="track unsettled"/);
});

test("a ledger with no recognisable PROVEN/OPEN split degrades to a plain list", () => {
  const md = "# T\n\n## Claims\n\n- one\n- two\n";
  const html = mdToHtml(md);
  doesNotMatch(html, /class="track settled"/);
  match(html, /<ul>/);
});

// ── standard markdown still works ───────────────────────────────────────

test("standard markdown: headings, bold, italic, inline code", () => {
  const html = mdToHtml("# H1\n\n## H2\n\nSome **bold** and *italic* and `code` text.\n");
  match(html, /<h1[^>]*>H1<\/h1>/);
  match(html, /<h2[^>]*>.*H2.*<\/h2>/s);
  match(html, /<strong>bold<\/strong>/);
  match(html, /<em>italic<\/em>/);
  match(html, /<code>code<\/code>/);
});

test("a GFM pipe table renders as an HTML table", () => {
  const md = "# T\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
  const html = mdToHtml(md);
  match(html, /<table>/);
  match(html, /<th[^>]*>A<\/th>/);
  match(html, /<td[^>]*>1<\/td>/);
});

test("a numbered ## heading splits the number into a mono accent", () => {
  const html = mdToHtml("# T\n\n## 1. The decision\n\ntext\n");
  match(html, /<span class="n">01<\/span>/);
  ok(html.includes("The decision"));
});

test("the H1 becomes the masthead title with the cross-examined eyebrow", () => {
  const html = mdToHtml("# PZ source note — crafting chain\n\nbody\n");
  match(html, /class="eyebrow"/);
  match(html, /class="title"/);
  ok(html.includes("crafting chain"));
});
