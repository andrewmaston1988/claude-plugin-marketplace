// Unit tests for escapeTags — the dynamic-text sanitiser that stops blessed's
// tag parser from reading data braces (e.g. `{a;b}` in a log line or commit
// message) as markup. Without it the parser splits a multi-part tag, recurses
// into _attr(), and crashes on `null.slice(2,-1)` (blessed program.js). Pure
// string logic, so unlike the render functions it is safe to unit-test directly.
import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { escapeTags } from "../src/dashboard/tui/style.mjs";

// blessed's tag-open matcher (lib/widgets/element.js). Data that matches this
// is what the parser tries to interpret as a colour/attr tag.
const BLESSED_TAG = /{\/?[\w\-,;!#]*}/g;

test("escapeTags: converts literal braces to blessed's {open}/{close} escapes", () => {
  equal(escapeTags("{a;b}"), "{open}a;b{close}");
  equal(escapeTags("a{b}c"), "a{open}b{close}c");
  equal(escapeTags("no braces"), "no braces");
});

test("escapeTags: the crash trigger no longer parses as a multi-part tag", () => {
  // `{red;bogus}` is the shape that crashes — the ';' makes blessed split it
  // into parts and recurse into _attr(), which returns null for 'bogus' and
  // throws on `.slice`. After escaping, the only tags blessed sees are the
  // safe {open}/{close} pair, never a comma/semicolon tag.
  const tags = escapeTags("{red;bogus}").match(BLESSED_TAG) || [];
  deepEqual(tags, ["{open}", "{close}"]);
  ok(!tags.some((t) => /[;,]/.test(t)), "no comma/semicolon tag survives escaping");
});

test("escapeTags: null/undefined/number coerce safely", () => {
  equal(escapeTags(null), "");
  equal(escapeTags(undefined), "");
  equal(escapeTags(123), "123");
});

test("escapeTags: input that looks like an escape is rewritten uniformly", () => {
  // User data literally containing "{open}" must render as that text, not be
  // mistaken for the escape — every brace is rewritten, so it round-trips.
  equal(escapeTags("{open}"), "{open}open{close}");
});
