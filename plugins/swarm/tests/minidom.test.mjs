// minidom — the plugin's only HTML parser. These tests pin the TREE, not a
// pattern: the segment scan in parseUsage scopes [data-usage-segment] queries
// per usage bar, so every case below is a way that scoping silently breaks.
import { test } from "node:test";
import { equal, deepEqual, ok, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHtml } from "../src/minidom.mjs";

// Test 7/8 — the tree the segment scan depends on. RED targets are named in
// the plan's test plan: void-tags-as-openers, naive close-tag unwinding,
// filter-afterwards raw text, and flat document-wide collection.

test("minidom: nesting — an outer element's queryAll finds its inner match, a sibling's does not", () => {
  const doc = parseHtml('<div data-x="outer"><span data-x="inner"></span></div><section data-x="sibling"></section>');
  const nodes = doc.querySelectorAll('[data-x]');
  equal(nodes.length, 3, "a document-wide query returns all three");
  const outer = nodes.find((n) => n.getAttribute("data-x") === "outer");
  const inner = nodes.find((n) => n.getAttribute("data-x") === "inner");
  const sibling = nodes.find((n) => n.getAttribute("data-x") === "sibling");
  ok(outer && inner && sibling);
  deepEqual(outer.querySelectorAll('[data-x]').map((n) => n.getAttribute("data-x")), ["inner"]);
  deepEqual(sibling.querySelectorAll('[data-x]'), [], "a sibling must not see another bar's subtree");
  equal(inner.parent, outer, "the inner node's parent is the outer node");
  equal(outer.parent, doc);
});

test("minidom: void and self-closing elements do not open a scope", () => {
  const doc = parseHtml('<div data-a="1"><br><img src="x.png"><foo /><span data-b="2">t</span></div>');
  const div = doc.querySelectorAll('[data-a]')[0];
  const span = doc.querySelectorAll('[data-b]')[0];
  equal(span.parent, div, "RED: <img> treated as an open tag nests the span inside it");
  const img = div.children.find((c) => c.tag === "img");
  ok(img, "the img itself is parsed as an element");
  deepEqual(img.querySelectorAll('[data-b]'), [], "a void element has no descendants");
  ok(!doc.querySelectorAll('[data-b]').some((n) => n.parent?.tag === "img"));
});

test("minidom: an unmatched close tag leaves the tree intact", () => {
  const doc = parseHtml('<div data-x="1"><span data-x="2">a</span></div></div><section data-y="3"><b data-y="4">b</b></section>');
  const sect = doc.querySelectorAll('[data-y="3"]')[0];
  ok(sect, "RED: naive cur = cur.parent unwinds past the root and the section attaches nowhere");
  equal(sect.parent, doc, "the section is a direct child of the root, not swallowed by the extra </div>");
  deepEqual(sect.querySelectorAll('[data-y]').map((n) => n.getAttribute("data-y")), ["4"]);
  const div = doc.querySelectorAll('[data-x="1"]')[0];
  deepEqual(div.querySelectorAll('[data-x]').map((n) => n.getAttribute("data-x")), ["2"], "the closed div keeps exactly its own subtree");
});

// The live page carries a data-usage-segment occurrence inside an inline
// <script>; the fake below is fully formed (all three attributes) so a
// filter-afterwards implementation cannot pass it by checking for missing
// attributes — only raw-text skipping keeps it out of the tree.
test("minidom: a fully-formed fake segment inside <script> yields NO element", () => {
  const doc = parseHtml(`<!DOCTYPE html><body>
    <script>
      const tpl = '<button data-usage-segment data-model="fake" data-requests="999" style="width:5%"></button>';
    </script>
    <div data-usage-track aria-label="Weekly usage 10% used">
      <span data-usage-segment data-model="real" data-requests="7" style="width:100%"></span>
    </div>
    <style>.x[data-usage-segment] { color: red }</style>
  </body>`);
  const segs = doc.querySelectorAll("[data-usage-segment]");
  equal(segs.length, 1, `RED: raw text parsed as markup — got ${segs.length} elements`);
  equal(segs[0].getAttribute("data-model"), "real");
  deepEqual(doc.querySelectorAll('[data-model="fake"]'), [], "the script-body fake must not exist as an element");
  const bars = doc.querySelectorAll("[aria-label]");
  equal(bars.length, 1);
  equal(bars[0].querySelectorAll("[data-usage-segment]").length, 1, "the real segment scopes to its bar");
});

test("minidom: attribute quoting — double, single, unquoted and bare all read", () => {
  const doc = parseHtml(`<div data-a="quoted" data-b='single' data-c=unquoted data-d data-e=""></div>`);
  const el = doc.querySelectorAll("[data-a]")[0];
  equal(el.getAttribute("data-a"), "quoted");
  equal(el.getAttribute("data-b"), "single");
  equal(el.getAttribute("data-c"), "unquoted");
  equal(el.getAttribute("data-d"), "", "a bare attribute reads as present with an empty value");
  equal(el.getAttribute("data-e"), "");
  equal(el.getAttribute("data-missing"), null, "an absent attribute reads as null, never undefined");
  deepEqual(doc.querySelectorAll('[data-a="quoted"]'), [el]);
  deepEqual(doc.querySelectorAll("[data-a='quoted']"), [el], "single-quoted selector values match too");
  deepEqual(doc.querySelectorAll("[data-d]"), [el], "[attr] matches a bare attribute");
  deepEqual(doc.querySelectorAll('[data-d=""]'), [el]);
  deepEqual(doc.querySelectorAll("[data-a='nope']"), [], "a non-matching value selects nothing");
  throws(() => doc.querySelectorAll("div"), /selector/, "only [attr] and [attr=\"v\"] selectors are supported — anything else must fail loudly, not return everything");
});

test("minidom: comments and declarations are skipped, tags are case-insensitive", () => {
  const doc = parseHtml(`<!-- <span data-x="commented"> --><DIV DATA-X="UPPER"></DIV><?php echo ?><!DOCTYPE html>`);
  const els = doc.querySelectorAll("[data-x]");
  equal(els.length, 1);
  equal(els[0].tag, "div");
});

// Test 8 — segments are scoped to their own bar. RED: collecting segments
// document-wide and splitting by position. This fixture mirrors the real
// page's shape (aria-label on the bar container, segments nested inside).
test("minidom: two bars — each sees only its own segments, the document sees all five", () => {
  const doc = parseHtml(readFileSync(join(import.meta.dirname, "fixtures", "two-bars.html"), "utf8"));
  const bars = doc.querySelectorAll("[aria-label]");
  equal(bars.length, 2);
  const session = bars.find((b) => b.getAttribute("aria-label").startsWith("Session usage "));
  const weekly = bars.find((b) => b.getAttribute("aria-label").startsWith("Weekly usage "));
  deepEqual(session.querySelectorAll("[data-usage-segment]").map((s) => s.getAttribute("data-model")), ["a", "b", "c"]);
  deepEqual(weekly.querySelectorAll("[data-usage-segment]").map((s) => s.getAttribute("data-model")), ["d", "e"]);
  equal(doc.querySelectorAll("[data-usage-segment]").length, 5);
  // The scoping is structural, not positional: a wrapper element inside one
  // bar must not leak the other bar's segments into it.
  const wrapper = session.querySelectorAll("[data-wrapper]")[0];
  ok(wrapper);
  deepEqual(wrapper.querySelectorAll("[data-usage-segment]").map((s) => s.getAttribute("data-model")), ["b", "c"]);
});

test("minidom: parse is pure — equal output on repeat, input untouched", () => {
  const html = '<div data-x="1"><span data-x="2"></span></div>';
  const first = parseHtml(html);
  const second = parseHtml(html);
  deepEqual(first.querySelectorAll("[data-x]").map((n) => n.getAttribute("data-x")), second.querySelectorAll("[data-x]").map((n) => n.getAttribute("data-x")));
  equal(html, '<div data-x="1"><span data-x="2"></span></div>');
});