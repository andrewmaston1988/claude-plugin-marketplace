import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { strictSchema, dropNullOptionals } from "../src/native-schema.mjs";

// The code-review finder's returns shape (the CLAUDE repo's
// skills/code-review/scripts/run-review.mjs `citationReturns()`): an
// array-of-object citations block whose `finding` and `severity_should_be` are
// optional. Every keyword it uses is one of the engine's five.
const FINDER_RETURNS = {
  type: "object",
  required: ["concerns"],
  properties: {
    concerns: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "file", "line", "quote"],
        properties: {
          label: { type: "string", enum: ["BLOCKER", "ADVISORY", "ABORT"] },
          finding: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          quote: { type: "string" },
          severity_should_be: { type: "string", enum: ["BLOCKER", "ADVISORY"] },
        },
      },
    },
    open_questions: { type: "array", items: { type: "string" } },
  },
};

const snapshot = (v) => JSON.stringify(v);

test("strictSchema: every object closed, every property required, an optional one nullable", () => {
  const s = strictSchema(FINDER_RETURNS);
  equal(s.additionalProperties, false);
  deepEqual(s.required, ["concerns", "open_questions"]);
  const item = s.properties.concerns.items;
  equal(item.additionalProperties, false);
  deepEqual([...item.required].sort(),
    ["file", "finding", "label", "line", "quote", "severity_should_be"]);
  // A required property keeps its declared type.
  deepEqual(item.properties.file, { type: "string" });
  deepEqual(item.properties.label, { type: "string", enum: ["BLOCKER", "ADVISORY", "ABORT"] });
  // An optional one becomes nullable so the model can still decline it.
  deepEqual(item.properties.finding, { type: ["string", "null"] });
  deepEqual(item.properties.severity_should_be,
    { type: ["string", "null"], enum: ["BLOCKER", "ADVISORY", null] });
  // An array is not an object: no additionalProperties, items carried through.
  equal(s.properties.open_questions.additionalProperties, undefined);
  deepEqual(s.properties.open_questions.items, { type: "string" });
});

test("strictSchema closes an object that declares no properties", () => {
  deepEqual(strictSchema({ type: "object" }), { type: "object", additionalProperties: false, required: [] });
});

test("strictSchema never mutates its input", () => {
  const input = JSON.parse(snapshot(FINDER_RETURNS));
  const before = snapshot(input);
  strictSchema(input);
  equal(snapshot(input), before);
});

test("strictSchema is total over the engine's five keywords", () => {
  for (const schema of [
    { type: "object", properties: { a: { type: "string" } } },
    { type: "object", properties: { a: { type: "integer" }, b: { enum: [1, 2] } } },
    { type: "object", properties: { a: { type: "array" } } },
    { type: "object", properties: { a: { type: "array", items: { enum: ["a", "b"] } } } },
    { type: "object", properties: { a: { type: "boolean" } } },
  ]) {
    equal(typeof strictSchema(schema), "object");
  }
  deepEqual(strictSchema({ type: "object", required: ["a"], properties: { a: { type: "array", items: { enum: ["a", "b"] } } } }),
    { type: "object", properties: { a: { type: "array", items: { enum: ["a", "b"] } } }, additionalProperties: false, required: ["a"] });
});

test("dropNullOptionals removes null optionals at every depth, keeps a required null", () => {
  const value = {
    concerns: [{
      label: "ADVISORY",
      file: "a.mjs",
      line: 3,
      quote: null,              // required inside items -> kept for validateValue
      finding: null,            // optional -> dropped
      severity_should_be: null, // optional -> dropped
    }],
    open_questions: null,       // optional at the top -> dropped
  };
  deepEqual(dropNullOptionals(value, FINDER_RETURNS), {
    concerns: [{ label: "ADVISORY", file: "a.mjs", line: 3, quote: null }],
  });
});

test("dropNullOptionals leaves a non-null value byte-identical", () => {
  const value = { concerns: [{ label: "BLOCKER", file: "b.mjs", line: 1, quote: "q", finding: "an integer overflows" }] };
  deepEqual(dropNullOptionals(value, FINDER_RETURNS), value);
  deepEqual(dropNullOptionals(value, undefined), value);
});

// Engine-legal shapes the strict conversion has to survive.
test("strictSchema: an untyped node carries the type its properties or items imply", () => {
  equal(strictSchema({ properties: { a: { type: "string" } } }).type, "object");
  equal(strictSchema({ properties: { a: { items: { type: "string" } } }, required: ["a"] }).properties.a.type, "array");
});

// Strict form lists every required key under properties; a required key with no
// property schema cannot be expressed, so the runner gets no native bind at all.
test("strictSchema: an object that requires a key it never describes has no strict form", () => {
  equal(strictSchema({ type: "object", required: ["a"] }), null);
  equal(strictSchema({ type: "object", properties: { list: { type: "array", items: { type: "object", required: ["x"] } } } }), null);
});

test("strictSchema: an optional property that already admits null is not widened twice", () => {
  const out = strictSchema({ type: "object", properties: { n: { type: "null" }, s: { type: ["string", "null"] }, e: { type: "string", enum: ["A", null] } } });
  deepEqual(out.properties.n.type, "null");
  deepEqual(out.properties.s.type, ["string", "null"]);
  deepEqual(out.properties.e.enum, ["A", null]);
});

test("dropNullOptionals: a null the schema itself admits is an answer, not a placeholder", () => {
  const schema = { type: "object", properties: { n: { type: "null" }, s: { type: ["string", "null"] }, e: { type: "string", enum: ["A", null] }, x: { type: "string" } } };
  deepEqual(dropNullOptionals({ n: null, s: null, e: null, x: null }, schema), { n: null, s: null, e: null });
});

test("strictSchema: a non-object root has no strict form", () => {
  equal(strictSchema({ type: "array", items: { type: "string" } }), null);
  equal(strictSchema({ type: "string" }), null);
});
