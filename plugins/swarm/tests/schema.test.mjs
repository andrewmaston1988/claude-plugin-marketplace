import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { validateSchemaShape, validateValue } from "../src/schema.mjs";

// The returns-schema contract lives here. Error-message asserts are
// load-bearing: validation is the teaching surface (authorability bar), so
// every error names the field, what was expected, and what arrived.

function shapeFails(schema, ...res) {
  const errs = validateSchemaShape(schema);
  ok(errs.length > 0, `expected shape errors for ${JSON.stringify(schema)}`);
  for (const re of res) {
    ok(errs.some((e) => re.test(e)), `expected ${re} in:\n${errs.join("\n")}`);
  }
  return errs;
}

// ── schema shape ──────────────────────────────────────────────────────────────

test("a well-formed schema over every supported keyword has no shape errors", () => {
  deepEqual(validateSchemaShape({
    type: "object",
    required: ["sites"],
    properties: {
      sites: { type: "array", items: { type: "object", properties: { file: { type: "string" } } } },
      status: { enum: ["clean", "dirty"] },
      count: { type: "integer" },
    },
  }), []);
});

test("schema must be a plain object", () => {
  shapeFails([], /returns must be an object/);
  shapeFails("string", /returns must be an object/);
  shapeFails(null, /returns must be an object/);
});

test("empty schema is rejected — it validates nothing", () => {
  shapeFails({}, /must constrain something/, /type/);
});

test("unknown keyword is rejected and the supported set is listed", () => {
  shapeFails({ type: "object", additionalProperties: false },
    /unknown keyword 'additionalProperties'/, /type, properties, required, items, enum/);
  shapeFails({ type: "array", minItems: 1 }, /unknown keyword 'minItems'/);
});

test("type must be a single known type name", () => {
  shapeFails({ type: "text" }, /type 'text' is not supported/, /string, number, integer, boolean, array, object, null/);
  shapeFails({ type: ["string", "null"] }, /a single type name/);
});

test("properties must be an object of sub-schemas; errors carry the nested path", () => {
  shapeFails({ type: "object", properties: [] }, /properties must be an object/);
  shapeFails({ type: "object", properties: { sites: { type: "list" } } }, /returns\.sites/, /type 'list'/);
});

test("required must be an array of strings", () => {
  shapeFails({ type: "object", required: "sites" }, /required must be an array of field names/);
  shapeFails({ type: "object", required: [1] }, /required must be an array of field names/);
});

test("required names missing from a declared properties block are flagged", () => {
  shapeFails({ type: "object", required: ["sites"], properties: { other: { type: "string" } } },
    /required field 'sites' is not declared in properties/);
});

test("items must be a single sub-schema; errors carry the [] path", () => {
  shapeFails({ type: "array", items: [{ type: "string" }] }, /items must be a single schema/);
  shapeFails({ type: "array", items: { type: "list" } }, /returns\[\]/, /type 'list'/);
});

test("enum must be a non-empty array", () => {
  shapeFails({ enum: [] }, /enum must be a non-empty array/);
  shapeFails({ enum: "clean" }, /enum must be a non-empty array/);
});

// ── value validation ──────────────────────────────────────────────────────────

function valueFails(value, schema, ...res) {
  const errs = validateValue(value, schema);
  ok(errs.length > 0, `expected value errors for ${JSON.stringify(value)}`);
  for (const re of res) {
    ok(errs.some((e) => re.test(e)), `expected ${re} in:\n${errs.join("\n")}`);
  }
  return errs;
}

test("a conforming value has no errors", () => {
  deepEqual(validateValue(
    { sites: [{ file: "a.mjs", line: 3 }], status: "clean" },
    {
      type: "object",
      required: ["sites"],
      properties: {
        sites: { type: "array", items: { type: "object", required: ["file"], properties: { file: { type: "string" }, line: { type: "integer" } } } },
        status: { enum: ["clean", "dirty"] },
      },
    },
  ), []);
});

test("type mismatch names the path, the expectation, and what arrived", () => {
  valueFails("prose", { type: "array" }, /output: expected array, got string/);
  valueFails({ sites: "none" }, { type: "object", properties: { sites: { type: "array" } } },
    /output\.sites: expected array, got string \("none"\)/);
  valueFails(null, { type: "object" }, /output: expected object, got null/);
});

test("integer means a whole number; number accepts any numeric", () => {
  deepEqual(validateValue(3, { type: "integer" }), []);
  valueFails(3.5, { type: "integer" }, /expected integer, got 3\.5/);
  deepEqual(validateValue(3.5, { type: "number" }), []);
});

test("missing required fields are named individually", () => {
  valueFails({}, { type: "object", required: ["file", "line"] },
    /output: missing required field 'file'/, /output: missing required field 'line'/);
});

test("extra fields pass — no additionalProperties in the subset", () => {
  deepEqual(validateValue({ a: 1, extra: true }, { type: "object", properties: { a: { type: "number" } } }), []);
});

test("items validates each element with its index in the path", () => {
  valueFails(["a", 2, "c"], { type: "array", items: { type: "string" } },
    /output\[1\]: expected string, got number \(2\)/);
});

test("enum mismatch lists the allowed values; objects compare deeply", () => {
  valueFails("other", { enum: ["clean", "dirty"] }, /output: must be one of \["clean","dirty"\]/, /got "other"/);
  deepEqual(validateValue({ a: [1] }, { enum: [{ a: [1] }] }), []);
  valueFails({ a: [2] }, { enum: [{ a: [1] }] }, /must be one of/);
});

test("long strings in got-values are truncated", () => {
  const errs = valueFails("x".repeat(200), { type: "array" }, /expected array, got string/);
  ok(errs[0].length < 150, `error too long: ${errs[0].length} chars`);
});

test("error flood is capped with a remainder note", () => {
  const errs = validateValue(Array.from({ length: 30 }, () => 1), { type: "array", items: { type: "string" } });
  ok(errs.length <= 11, `expected cap, got ${errs.length}`);
  ok(/and \d+ more/.test(errs[errs.length - 1]), `expected remainder note in:\n${errs.join("\n")}`);
});

test("missing fields under properties are not type-checked — only required flags absence", () => {
  deepEqual(validateValue({}, { type: "object", properties: { a: { type: "string" } } }), []);
});
