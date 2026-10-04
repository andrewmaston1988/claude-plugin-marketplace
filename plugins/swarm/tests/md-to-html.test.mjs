// The report.md → report.html renderer. A MECHANICAL projection of the markdown:
// standard md → html PLUS five semantic upgrades (verdict badges, operator-feel
// chip, path:line citations, coverage callout, provenance strip) and a synthesised
// confidence tally. These tests pin the LOAD-BEARING failure modes the plan names —
// HTML-injection, badge-word-in-prose, path:line-in-a-fence, malformed input — and
// the upgrades themselves.
import { test } from "node:test";
import { ok, match, doesNotMatch, equal, deepEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mdToHtml, renderRunPages } from "../src/md_to_html.mjs";

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

// ── phone width: selector PLACEMENT, not substring ─────────────────────
// A bare "CSS contains overflow-wrap" check passes with the rule on the wrong
// element, which is exactly how the narrow-view defect shipped. Parse the
// stylesheet into selector → declarations and assert WHERE each rule lives.

// Minimal block parser for a generated stylesheet (no braces inside strings):
// @media/@keyframes bodies are walked through and their inner rules surface
// under their own selectors; comments stripped; a trailing declaration without
// its `;` is still captured.
function cssRules(html) {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1].replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const stack = [];
  let buf = "";
  for (const ch of css) {
    if (ch === "{") { stack.push({ selector: buf.trim(), decls: [] }); buf = ""; }
    else if (ch === "}") {
      const b = stack.pop();
      const trailing = buf.trim();
      if (b && !b.selector.startsWith("@")) {
        if (trailing) b.decls.push(trailing);
        rules.push(b);
      }
      buf = "";
    } else if (ch === ";" && stack.length) {
      if (buf.trim()) stack[stack.length - 1].decls.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  return rules;
}
const ruleOf = (rules, selector) => rules.find((r) => r.selector === selector);
const decl = (rule, prop) => rule?.decls
  .map((d) => d.replace(/\s+/g, " ").replace(/:\s*/, ": "))
  .find((d) => d.startsWith(prop));

test("the ground sits on html/body — the overflow strip past .doc is not white", () => {
  const rules = cssRules(mdToHtml("# T\n\ntext\n"));
  const ground = ruleOf(rules, "html, body");
  ok(ground, "an `html, body` rule must exist");
  equal(decl(ground, "background"), "background: var(--ground)");
  equal(decl(ground, "color"), "color: var(--ink)");
});

test("long paths wrap: overflow-wrap lives on .doc itself", () => {
  const rules = cssRules(mdToHtml("# T\n\ntext\n"));
  equal(decl(ruleOf(rules, ".doc"), "overflow-wrap"), "overflow-wrap: anywhere");
});

test("citations wrap — cite loses nowrap; the short fixed-label chips keep theirs", () => {
  const rules = cssRules(mdToHtml("# T\n\ntext\n"));
  ok(!decl(ruleOf(rules, "cite, .cite"), "white-space"), "cite must not force nowrap");
  equal(decl(ruleOf(rules, ".badge"), "white-space"), "white-space: nowrap");
  equal(decl(ruleOf(rules, ".feel"), "white-space"), "white-space: nowrap");
});

test(".doc keeps its own styling — the html/body rule is additive, not a re-copy", () => {
  const rules = cssRules(mdToHtml("# T\n\ntext\n"));
  const doc = ruleOf(rules, ".doc");
  equal(decl(doc, "min-height"), "min-height: 100vh");
  equal(decl(doc, "font-family"), "font-family: var(--serif)");
  ok(decl(doc, "padding").startsWith("padding: clamp(1.2rem"));
});

// ── kind: each document names itself ────────────────────────────────────

test("kind 'digest' leads with the compressed-handoff eyebrow, never the source-review one", () => {
  const html = mdToHtml("# T\n\nbody\n", { kind: "digest" });
  ok(html.includes("Swarm digest · compressed handoff"), "the digest page names itself a digest");
  ok(!html.includes("Swarm source review"), "the report eyebrow must not lead a digest page");
});

test("no kind, and kind 'report', keep the cross-examined source-review eyebrow", () => {
  ok(mdToHtml("# T\n\ntext\n").includes("Swarm source review · cross-examined"));
  ok(mdToHtml("# T\n\ntext\n", { kind: "report" }).includes("Swarm source review · cross-examined"));
});

// ── renderRunPages: the engine's own HTML writer ────────────────────────
// digest.md → digest.html, report.md → report.html — the scheduler calls it
// after every footnote; `swarm report` calls it as the backfill. Atomic per
// page (tmp + rename), skip-missing, and a failed page never takes the healthy
// one down.

const pageDir = () => mkdtempSync(join(tmpdir(), "swarm-md-html-"));
const tmpFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("writes digest.html and report.html with run-named titles and their own eyebrows", () => {
  const dir = pageDir();
  try {
    writeFileSync(join(dir, "digest.md"), "# Digest — compressed handoff\n\n- one\n");
    writeFileSync(join(dir, "report.md"), "# Callers of frobnicate\n\nBoth leaves ran.\n");
    deepEqual(renderRunPages(dir, { runName: "dwreview-1" }),
      [join(dir, "digest.html"), join(dir, "report.html")]);
    const digest = readFileSync(join(dir, "digest.html"), "utf8");
    ok(digest.includes("<title>dwreview-1 · digest</title>"), "the digest page names itself after the run");
    ok(digest.includes("Swarm digest · compressed handoff"));
    const report = readFileSync(join(dir, "report.html"), "utf8");
    ok(report.includes("<title>dwreview-1 · report</title>"));
    ok(report.includes("Swarm source review · cross-examined"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skips a missing source; an empty dir writes nothing and returns no paths", () => {
  const dir = pageDir();
  try {
    writeFileSync(join(dir, "digest.md"), "# Just the digest\n\n- one\n");
    mkdirSync(join(dir, "empty"));
    deepEqual(renderRunPages(dir, { runName: "r" }), [join(dir, "digest.html")]);
    equal(existsSync(join(dir, "report.html")), false, "no report.md → no report.html");
    deepEqual(renderRunPages(join(dir, "empty"), { runName: "r" }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic: no .tmp survives a successful render", () => {
  const dir = pageDir();
  try {
    writeFileSync(join(dir, "digest.md"), "# D\n\nbody\n");
    renderRunPages(dir, { runName: "r" });
    equal(tmpFiles(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The scheduler and a manual `swarm report` can render one run at once; each
// writer owns its own tmp, so another writer's tmp never blocks this one.
test("a tmp held by a concurrent writer does not block the render", () => {
  const dir = pageDir();
  try {
    writeFileSync(join(dir, "digest.md"), "# D\n\nbody\n");
    mkdirSync(join(dir, "digest.html.tmp"));
    deepEqual(renderRunPages(dir, { runName: "r" }), [join(dir, "digest.html")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed re-render removes the old page rather than serve it stale", () => {
  const dir = pageDir();
  try {
    writeFileSync(join(dir, "digest.md"), "# Old\n\nbody\n");
    writeFileSync(join(dir, "report.md"), "# R\n\nbody\n");
    renderRunPages(dir, { runName: "r" });
    writeFileSync(join(dir, "digest.md"), "# New\n\nbody\n");
    mkdirSync(join(dir, `digest.html.${process.pid}.tmp`)); // this writer's tmp cannot be written
    deepEqual(renderRunPages(dir, { runName: "r" }), [join(dir, "report.html")]);
    equal(existsSync(join(dir, "digest.html")), false, "no stale digest.html left to serve");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a page that cannot land is skipped tmp-clean; every page failing throws", () => {
  const dir = pageDir();
  try {
    writeFileSync(join(dir, "digest.md"), "# D\n\nbody\n");
    writeFileSync(join(dir, "report.md"), "# R\n\nbody\n");
    mkdirSync(join(dir, "digest.html")); // rename cannot replace a directory
    deepEqual(renderRunPages(dir, { runName: "r" }), [join(dir, "report.html")],
      "the healthy page still lands");
    equal(tmpFiles(dir).length, 0, "the failed page leaves no half-written tmp");

    rmSync(join(dir, "report.html")); // phase 1 wrote it; make it unlandable too
    mkdirSync(join(dir, "report.html"));
    throws(() => renderRunPages(dir, { runName: "r" }), /could not render/,
      "nothing written at all is an error, not a silent empty result");
    equal(tmpFiles(dir).length, 0, "still no tmp after the throw");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
