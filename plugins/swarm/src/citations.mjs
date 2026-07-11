// N3: mechanical citation verification. When a `returns` schema declares
// citation-shaped objects ({file, line, quote}, all required), the engine
// verifies each citation deterministically — open the file, check the line,
// string-match the quote. Zero models, zero tokens. An `ok` leaf's citations
// are all verified; fabricated ones are refuted before any verifier spawns.
// Verifies EXISTENCE, not SUPPORT — judging whether a real span supports the
// claim stays with the verifier wave.

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Off-by-a-little is sloppiness, not fabrication: match the cited line first,
// then a ±2 window (drift recorded). Beyond that the citation is refuted.
const WINDOW = [-1, 1, -2, 2];
const MAX_ERROR_LINES = 10; // schema.mjs cap discipline: teach, don't flood

// Whitespace is not the fabrication signal — models re-indent quotes.
const norm = (s) => String(s).replace(/\s+/g, " ").trim();

export function isCitationSchema(schema) {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return false;
  const req = Array.isArray(schema.required) ? schema.required : [];
  const p = schema.properties;
  return ["file", "line", "quote"].every((k) => req.includes(k))
    && p.file?.type === "string"
    && (p.line?.type === "integer" || p.line?.type === "number")
    && p.quote?.type === "string";
}

// Schema paths where citations live — the validate announcement's evidence.
export function citationPaths(schema, path = "output") {
  if (!isPlainObject(schema)) return [];
  if (isCitationSchema(schema)) return [path];
  const out = [];
  if (isPlainObject(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      out.push(...citationPaths(sub, `${path}.${name}`));
    }
  }
  if (isPlainObject(schema.items)) out.push(...citationPaths(schema.items, `${path}[]`));
  return out;
}

// Walk value+schema together, collecting citation instances with their JSON
// path (schema validation has already passed, so the three fields exist).
export function extractCitations(value, schema, path = "output") {
  if (!isPlainObject(schema)) return [];
  if (isCitationSchema(schema) && isPlainObject(value)) {
    return [{ path, file: value.file, line: value.line, quote: value.quote }];
  }
  const out = [];
  if (isPlainObject(value) && isPlainObject(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, name)) out.push(...extractCitations(value[name], sub, `${path}.${name}`));
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((el, i) => out.push(...extractCitations(el, schema.items, `${path}[${i}]`)));
  }
  return out;
}

// cwds in priority order (effective cwd first, originalCwd second — the leaf
// read files where it ran). A path escaping every cwd is refuted unseen: the
// engine does not read arbitrary filesystem paths on a model's say-so.
export function verifyCitations(citations, { cwds, readFile = (p) => readFileSync(p, "utf8") }) {
  const roots = [...new Set(cwds.filter(Boolean).map((c) => resolve(c)))];
  const drifted = [];
  const refuted = [];
  let checked = 0;
  for (const c of citations) {
    const reason = verifyOne(c, roots, readFile, drifted);
    if (reason) refuted.push({ ...c, reason });
    else checked++;
  }
  return { checked, drifted, refuted };
}

function verifyOne(c, roots, readFile, drifted) {
  let inside = false;
  let content = null;
  for (const root of roots) {
    const abs = resolve(root, c.file);
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    inside = true;
    try {
      content = readFile(abs);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") return `cannot read ${c.file} (${e.code || e.message})`;
    }
  }
  if (!inside) return `cites a file outside the task's cwd: ${c.file}`;
  if (content === null) return `${c.file} does not exist under the task's cwd`;

  const lines = String(content).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const n = lines.length;
  if (!Number.isInteger(c.line) || c.line < 1 || c.line > n) {
    return `${c.file}: file has ${n} ${n === 1 ? "line" : "lines"} — cited line ${c.line}`;
  }

  const q = norm(String(c.quote).split("\n")[0]);
  if (!q) return `quote is empty — cite the actual source line`;
  const matchAt = (ln) => ln >= 1 && ln <= n && norm(lines[ln - 1]).includes(q);
  if (matchAt(c.line)) return null;
  for (const off of WINDOW) {
    if (matchAt(c.line + off)) {
      drifted.push({ path: c.path, line: c.line, matchedLine: c.line + off });
      return null;
    }
  }
  return `quote not found in ${c.file} at line ${c.line} (searched ±2)`;
}

// Refutations as teaching lines for the corrective re-ask, capped.
export function citationErrorLines(refuted) {
  const lines = refuted.slice(0, MAX_ERROR_LINES)
    .map((r) => `${r.path}: ${r.reason} — correct the citation or withdraw the claim`);
  if (refuted.length > MAX_ERROR_LINES) lines.push(`…and ${refuted.length - MAX_ERROR_LINES} more`);
  return lines;
}
