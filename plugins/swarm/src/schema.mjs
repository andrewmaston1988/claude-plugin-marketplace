// Hand-rolled JSON-Schema subset for per-task `returns` blocks. Supported
// keywords: type, properties, required, items, enum — nothing else, and an
// unknown keyword is an error (a silently ignored constraint would let
// authors believe a guarantee holds that doesn't). Same discipline as
// expr.mjs: no eval, own-properties only, every error teaches.

import { deepEq } from "./expr.mjs";

const SUPPORTED_KEYWORDS = ["type", "properties", "required", "items", "enum"];
const TYPES = ["string", "number", "integer", "boolean", "array", "object", "null"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Well-formedness of the schema itself — run at manifest-validate time so a
// bad schema dies in the preview, not mid-run. Returns teaching errors, each
// prefixed with the path into the schema (e.g. "returns.sites").
export function validateSchemaShape(schema, path = "returns") {
  if (!isPlainObject(schema)) {
    return [`${path} must be an object — e.g. {"type": "object", "required": ["sites"]}`];
  }
  const errs = [];
  const keys = Object.keys(schema);
  for (const k of keys) {
    if (!SUPPORTED_KEYWORDS.includes(k)) {
      errs.push(`${path}: unknown keyword '${k}' — supported: ${SUPPORTED_KEYWORDS.join(", ")}`);
    }
  }
  if (!keys.some((k) => SUPPORTED_KEYWORDS.includes(k))) {
    errs.push(`${path}: the schema must constrain something — give it a type, e.g. {"type": "array"}`);
  }
  if (schema.type !== undefined) {
    if (typeof schema.type !== "string") {
      errs.push(`${path}: type must be a single type name string (got ${JSON.stringify(schema.type)})`);
    } else if (!TYPES.includes(schema.type)) {
      errs.push(`${path}: type '${schema.type}' is not supported — use one of: ${TYPES.join(", ")}`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      errs.push(`${path}: properties must be an object mapping field names to schemas`);
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        errs.push(...validateSchemaShape(sub, `${path}.${name}`));
      }
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
      errs.push(`${path}: required must be an array of field names — e.g. "required": ["file", "line"]`);
    } else if (isPlainObject(schema.properties)) {
      for (const name of schema.required) {
        if (!Object.hasOwn(schema.properties, name)) {
          errs.push(`${path}: required field '${name}' is not declared in properties — add it or drop it from required`);
        }
      }
    }
  }
  if (schema.items !== undefined) {
    if (!isPlainObject(schema.items)) {
      errs.push(`${path}: items must be a single schema applied to every element (got ${JSON.stringify(schema.items)})`);
    } else {
      errs.push(...validateSchemaShape(schema.items, `${path}[]`));
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      errs.push(`${path}: enum must be a non-empty array of allowed values — e.g. "enum": ["clean", "dirty"]`);
    }
  }
  return errs;
}

const MAX_VALUE_ERRORS = 10;

const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// Render a got-value for an error message, truncated — the message must teach,
// not dump the payload back at the model.
const show = (v) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
};

// Validate a parsed leaf output against a (shape-checked) schema. Teaching
// errors with a JSON path into the value; capped so a systematically wrong
// output reads as a lesson, not a flood.
export function validateValue(value, schema, path = "output") {
  const errs = [];
  check(value, schema, path, errs);
  if (errs.length > MAX_VALUE_ERRORS) {
    const extra = errs.length - MAX_VALUE_ERRORS;
    errs.length = MAX_VALUE_ERRORS;
    errs.push(`…and ${extra} more`);
  }
  return errs;
}

function check(value, schema, path, errs) {
  if (schema.type !== undefined) {
    const t = typeName(value);
    const okType = schema.type === "integer"
      ? t === "number" && Number.isInteger(value)
      : t === schema.type;
    if (!okType) {
      const got = value === null ? "null"
        : schema.type === "integer" && t === "number" ? show(value) // "got 3.5" beats "got number"
        : `${t} (${show(value)})`;
      errs.push(`${path}: expected ${schema.type}, got ${got}`);
      return; // a wrong-typed value's members are noise, not extra lessons
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => deepEq(value, allowed))) {
    errs.push(`${path}: must be one of ${show(schema.enum)} — got ${show(value)}`);
    return;
  }
  if (isPlainObject(value)) {
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) errs.push(`${path}: missing required field '${name}'`);
    }
    if (isPlainObject(schema.properties)) {
      for (const [name, sub] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, name)) check(value[name], sub, `${path}.${name}`, errs);
      }
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((el, i) => check(el, schema.items, `${path}[${i}]`, errs));
  }
}
