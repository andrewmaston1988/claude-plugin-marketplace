// Native binding of a task's `returns` to the runner's own schema flag.
//
// `codex exec --output-schema` refuses anything but OpenAI's strict form: HTTP 400
// invalid_json_schema, "'additionalProperties' is required to be supplied and to be
// false". Strict form means every object is closed and every property is listed in
// `required` — so an originally optional property must become nullable, or the model
// has to invent a value rather than decline. The engine's schema grammar is the five
// keywords validateValue reads (type, properties, required, items, enum), and all five
// are strict-compatible, so the conversion is total: no manifest has to change.

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A node with no `type` still has a shape the engine checks positionally — properties
// make it an object, items an array. Inferring it is what lets an optional untyped
// property take a null.
function inferredType(node) {
  if (isPlainObject(node.properties)) return "object";
  if (isPlainObject(node.items)) return "array";
  return undefined;
}

const admitsNull = (node) =>
  node.type === "null" || (Array.isArray(node.type) && node.type.includes("null")) ||
  (Array.isArray(node.enum) && node.enum.includes(null));

// The strict form of an optional property: same constraints, plus null.
function nullable(node) {
  if (admitsNull(node)) return node;
  const out = { ...node };
  if (node.type !== undefined) out.type = Array.isArray(node.type) ? [...node.type, "null"] : [node.type, "null"];
  if (Array.isArray(node.enum)) out.enum = [...node.enum, null];
  return out;
}

/** Rewrite a `returns` schema into OpenAI strict form. Pure — never mutates its input.
 *  Null when the schema has no strict form: a required key strict mode cannot list. */
export function strictSchema(schema) {
  if (!isPlainObject(schema)) return schema;
  const out = {};
  const type = schema.type !== undefined ? schema.type : inferredType(schema);
  if (type !== undefined) out.type = type;
  if (Array.isArray(schema.enum)) out.enum = [...schema.enum];
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((name) => !(name in props))) return null;
  if (isPlainObject(schema.properties)) {
    out.properties = {};
    for (const [name, sub] of Object.entries(schema.properties)) {
      const child = strictSchema(sub);
      if (child === null) return null;
      out.properties[name] = required.includes(name) ? child : nullable(child);
    }
  }
  if (type === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(props);
  }
  if (isPlainObject(schema.items)) {
    out.items = strictSchema(schema.items);
    if (out.items === null) return null;
  }
  return out;
}

// Strict form forces every property present, so an optional one arrives as an explicit
// null. A null for a property the ORIGINAL schema does not require carries no
// information — dropping it before validateValue is lossless for every runner and keeps
// one validation path. A required null is kept: the author's schema is what gets checked.
export function dropNullOptionals(value, schema) {
  if (!isPlainObject(schema)) return value;
  if (Array.isArray(value)) {
    return isPlainObject(schema.items) ? value.map((el) => dropNullOptionals(el, schema.items)) : value;
  }
  if (!isPlainObject(value)) return value;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const out = {};
  for (const [name, v] of Object.entries(value)) {
    const sub = isPlainObject(schema.properties) ? schema.properties[name] : undefined;
    if (v === null && !required.includes(name) && !(isPlainObject(sub) && admitsNull(sub))) continue;
    out[name] = isPlainObject(sub) ? dropNullOptionals(v, sub) : v;
  }
  return out;
}
