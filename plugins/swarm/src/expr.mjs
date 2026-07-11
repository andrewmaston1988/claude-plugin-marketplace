// Bounded expression language for manifest `when` / `compute` steps.
//
// Deliberately tiny: literals, scope identifiers, member access, comparisons,
// boolean logic, and a fixed function table. No eval/new Function — manifests
// may be authored by a leaf model mid-composition, so the trust boundary stays
// tight: expressions can only read the JSON they are handed. Logic is
// boolean-strict (no truthiness) and member access resolves own properties
// only, so prototype chains are unreachable.
//
// Every error is a teaching error (authorability bar): name what failed, echo
// the source with a caret, hint the fix.

export const MAX_EXPR_LEN = 500;

export class ExprError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExprError";
  }
}

const FUNCS = {
  length: [1, 1],
  count: [1, 2],
  unique_by: [2, 2],
  filter: [2, 2],
  flatten: [1, 1],
  min: [1, 1],
  max: [1, 1],
  sum: [1, 1],
  contains: [2, 2],
};
const FUNC_LIST = Object.keys(FUNCS).join(", ");

const norm = (v) => (v === undefined ? null : v);
const typeName = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function fail(msg, src, pos) {
  let m = msg;
  if (src != null) {
    m += `\n  ${String(src).replace(/\n/g, " ")}`;
    if (pos != null) m += `\n  ${" ".repeat(Math.max(0, pos))}^`;
  }
  throw new ExprError(m);
}

// ── tokenizer ─────────────────────────────────────────────────────────────────

const TWO_CHAR = ["==", "!=", ">=", "<=", "&&", "||"];
const ONE_CHAR = new Set([">", "<", "!", "-", "(", ")", "[", "]", ",", "."]);
const ARITH = new Set(["+", "*", "/", "%"]);

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1])) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ k: "num", v: Number(src.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; }
        else { s += src[j]; j++; }
      }
      if (j >= src.length) fail(`unterminated string — missing a closing ${c}`, src, i);
      toks.push({ k: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: "ident", v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      toks.push({ k: "op", v: two, pos: i });
      i += 2;
      continue;
    }
    if (ARITH.has(c)) {
      fail(`arithmetic ('${c}') is not supported — the grammar is comparisons and logic; aggregate with sum(), count(), length()`, src, i);
    }
    if (ONE_CHAR.has(c)) {
      toks.push({ k: "op", v: c, pos: i });
      i++;
      continue;
    }
    fail(`unexpected character '${c}'`, src, i);
  }
  toks.push({ k: "eof", v: "", pos: src.length });
  return toks;
}

// ── parser (recursive descent) ────────────────────────────────────────────────

const CMP_OPS = new Set(["==", "!=", ">", ">=", "<", "<="]);

export function parseExpr(src) {
  if (typeof src !== "string") fail(`expression must be a string (got ${typeName(src)})`);
  if (!src.trim()) fail("empty expression — write a predicate like length(value) > 0", src, 0);
  if (src.length > MAX_EXPR_LEN) {
    fail(`expression is ${src.length} characters — the cap is ${MAX_EXPR_LEN}; split the logic across compute steps`);
  }
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expectOp = (v, what) => {
    if (peek().k === "op" && peek().v === v) return next();
    fail(`expected '${v}' ${what}`, src, peek().pos);
  };

  function parseOr() {
    let l = parseAnd();
    while (peek().k === "op" && peek().v === "||") {
      const { pos } = next();
      l = { k: "or", l, r: parseAnd(), pos };
    }
    return l;
  }
  function parseAnd() {
    let l = parseCmp();
    while (peek().k === "op" && peek().v === "&&") {
      const { pos } = next();
      l = { k: "and", l, r: parseCmp(), pos };
    }
    return l;
  }
  function parseCmp() {
    let l = parseUnary();
    if (peek().k === "op" && CMP_OPS.has(peek().v)) {
      const { v: op, pos } = next();
      l = { k: "cmp", op, l, r: parseUnary(), pos };
      if (peek().k === "op" && CMP_OPS.has(peek().v)) {
        fail("chained comparisons are not supported — split into two comparisons joined with &&", src, peek().pos);
      }
    }
    return l;
  }
  function parseUnary() {
    if (peek().k === "op" && peek().v === "!") {
      const { pos } = next();
      return { k: "not", e: parseUnary(), pos };
    }
    if (peek().k === "op" && peek().v === "-") {
      const { pos } = next();
      return { k: "neg", e: parseUnary(), pos };
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let e = parsePrimary();
    for (;;) {
      if (peek().k === "op" && peek().v === ".") {
        const { pos } = next();
        const id = next();
        if (id.k !== "ident") fail("expected a field name after '.'", src, id.pos);
        e = { k: "mem", obj: e, key: id.v, computed: false, pos };
      } else if (peek().k === "op" && peek().v === "[") {
        const { pos } = next();
        const key = parseOr();
        expectOp("]", "to close the index");
        e = { k: "mem", obj: e, key, computed: true, pos };
      } else {
        return e;
      }
    }
  }
  function parsePrimary() {
    const t = next();
    if (t.k === "num") return { k: "lit", v: t.v, pos: t.pos };
    if (t.k === "str") return { k: "lit", v: t.v, pos: t.pos };
    if (t.k === "ident") {
      if (t.v === "true") return { k: "lit", v: true, pos: t.pos };
      if (t.v === "false") return { k: "lit", v: false, pos: t.pos };
      if (t.v === "null") return { k: "lit", v: null, pos: t.pos };
      if (peek().k === "op" && peek().v === "(") {
        if (!(t.v in FUNCS)) fail(`unknown function '${t.v}' — available: ${FUNC_LIST}`, src, t.pos);
        next(); // (
        const args = [];
        if (!(peek().k === "op" && peek().v === ")")) {
          args.push(parseOr());
          while (peek().k === "op" && peek().v === ",") {
            next();
            args.push(parseOr());
          }
        }
        expectOp(")", "to close the call");
        const [lo, hi] = FUNCS[t.v];
        if (args.length < lo || args.length > hi) {
          const want = lo === hi ? (lo === 1 ? "1 argument" : `${lo} arguments`) : `${lo}–${hi} arguments`;
          fail(`${t.v}() takes ${want} (got ${args.length})`, src, t.pos);
        }
        return { k: "call", name: t.v, args, pos: t.pos };
      }
      return { k: "id", name: t.v, pos: t.pos };
    }
    if (t.k === "op" && t.v === "(") {
      const e = parseOr();
      expectOp(")", "to close the group");
      return e;
    }
    fail(t.k === "eof" ? "unexpected end of expression" : `unexpected '${t.v}'`, src, t.pos);
  }

  const ast = parseOr();
  if (peek().k !== "eof") fail(`unexpected '${peek().v}' after the expression`, src, peek().pos);
  return ast;
}

// ── evaluator ─────────────────────────────────────────────────────────────────

function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEq(a[k], b[k]));
  }
  return false;
}

function requireBool(v, ctx, pos, where) {
  if (typeof v !== "boolean") {
    fail(`${where} must be true/false (got ${typeName(v)}) — write a comparison like item > 0 or length(...) > 0`, ctx.src, pos);
  }
  return v;
}

function requireArray(fn, v, ctx, pos) {
  if (!Array.isArray(v)) fail(`${fn}() takes an array (got ${typeName(v)})`, ctx.src, pos);
  return v;
}

function member(base, key, node, ctx) {
  const seg = node.computed ? `[${typeName(key) === "string" ? `'${key}'` : key}]` : `.${node.key}`;
  if (base === null) {
    fail(`cannot access '${seg}' on null — the value before it is null/missing`, ctx.src, node.pos);
  }
  if (Array.isArray(base)) {
    if (typeof key === "number") {
      if (!Number.isInteger(key)) fail(`array index must be an integer (got ${key})`, ctx.src, node.pos);
      return norm(base[key]);
    }
    fail(`arrays have no fields — use length(...) to count elements, or an index like [0]`, ctx.src, node.pos);
  }
  if (typeof base === "string") {
    fail(`strings have no fields — use length() or contains()`, ctx.src, node.pos);
  }
  if (!isPlainObject(base)) {
    fail(`cannot access '${seg}' on a ${typeName(base)}`, ctx.src, node.pos);
  }
  const k = typeof key === "number" ? String(key) : key;
  if (typeof k !== "string") fail(`object fields are accessed with a string key (got ${typeName(key)})`, ctx.src, node.pos);
  return Object.hasOwn(base, k) ? norm(base[k]) : null;
}

function ev(node, ctx) {
  switch (node.k) {
    case "lit":
      return node.v;
    case "id": {
      if (Object.hasOwn(ctx.scope, node.name)) return norm(ctx.scope[node.name]);
      const avail = Object.keys(ctx.scope).join(", ") || "(none)";
      fail(`unknown identifier '${node.name}' — available here: ${avail}`, ctx.src, node.pos);
      break;
    }
    case "mem": {
      const base = ev(node.obj, ctx);
      const key = node.computed ? ev(node.key, ctx) : node.key;
      // deps is the declared-dependency namespace: a missing id there is an
      // authoring mistake, not absent data — teach with the declared list.
      if (
        node.obj.k === "id" && node.obj.name === "deps" &&
        isPlainObject(base) && typeof key === "string" && !Object.hasOwn(base, key)
      ) {
        fail(`unknown task id '${key}' in deps — declared dependencies: ${Object.keys(base).join(", ") || "(none)"}`, ctx.src, node.pos);
      }
      return member(base, key, node, ctx);
    }
    case "not":
      return !requireBool(ev(node.e, ctx), ctx, node.pos, "the '!' operand");
    case "neg": {
      const v = ev(node.e, ctx);
      if (typeof v !== "number") fail(`unary '-' needs a number (got ${typeName(v)})`, ctx.src, node.pos);
      return -v;
    }
    case "and": {
      if (!requireBool(ev(node.l, ctx), ctx, node.pos, "the left side of '&&'")) return false;
      return requireBool(ev(node.r, ctx), ctx, node.pos, "the right side of '&&'");
    }
    case "or": {
      if (requireBool(ev(node.l, ctx), ctx, node.pos, "the left side of '||'")) return true;
      return requireBool(ev(node.r, ctx), ctx, node.pos, "the right side of '||'");
    }
    case "cmp": {
      const l = ev(node.l, ctx);
      const r = ev(node.r, ctx);
      if (node.op === "==") return deepEq(l, r);
      if (node.op === "!=") return !deepEq(l, r);
      if (typeof l !== "number" || typeof r !== "number") {
        fail(`'${node.op}' compares numbers only (got ${typeName(l)} and ${typeName(r)})`, ctx.src, node.pos);
      }
      if (node.op === ">") return l > r;
      if (node.op === ">=") return l >= r;
      if (node.op === "<") return l < r;
      return l <= r;
    }
    case "call":
      return call(node, ctx);
    default:
      fail(`internal: unknown node '${node.k}'`);
  }
}

function call(node, ctx) {
  const { name, args, pos } = node;

  // count/filter take a predicate expression, evaluated per element with
  // `item` bound — lazily, so the predicate never runs against the whole array.
  if (name === "count" || name === "filter") {
    const arr = requireArray(name, ev(args[0], ctx), ctx, pos);
    if (name === "count" && args.length === 1) return arr.length;
    const out = [];
    for (const el of arr) {
      const r = ev(args[1], { ...ctx, scope: { ...ctx.scope, item: norm(el) } });
      requireBool(r, ctx, args[1].pos, `the ${name}() predicate`);
      if (r) out.push(el);
    }
    return name === "count" ? out.length : out;
  }

  const vals = args.map((a) => ev(a, ctx));
  switch (name) {
    case "length": {
      const v = vals[0];
      if (typeof v === "string" || Array.isArray(v)) return v.length;
      fail(`length() takes a string or array (got ${typeName(v)})`, ctx.src, pos);
      break;
    }
    case "unique_by": {
      const arr = requireArray("unique_by", vals[0], ctx, pos);
      const key = vals[1];
      if (typeof key !== "string") fail(`unique_by() key must be a string (got ${typeName(key)})`, ctx.src, pos);
      const seen = new Set();
      const out = [];
      for (const el of arr) {
        if (!isPlainObject(el)) fail(`unique_by() needs an array of objects (got a ${typeName(el)} element)`, ctx.src, pos);
        const kv = JSON.stringify(Object.hasOwn(el, key) ? el[key] : null);
        if (!seen.has(kv)) {
          seen.add(kv);
          out.push(el);
        }
      }
      return out;
    }
    case "flatten":
      return requireArray("flatten", vals[0], ctx, pos).flat(1);
    case "min":
    case "max":
    case "sum": {
      const arr = requireArray(name, vals[0], ctx, pos);
      for (const el of arr) {
        if (typeof el !== "number") fail(`${name}() needs numbers (got ${typeName(el)} ${JSON.stringify(el)})`, ctx.src, pos);
      }
      if (name === "sum") return arr.reduce((a, b) => a + b, 0);
      if (arr.length === 0) fail(`${name}() of an empty array has no value — guard with length(...) > 0`, ctx.src, pos);
      return name === "min" ? Math.min(...arr) : Math.max(...arr);
    }
    case "contains": {
      const [a, b] = vals;
      if (typeof a === "string") {
        if (typeof b !== "string") fail(`contains() on a string needs a string to look for (got ${typeName(b)})`, ctx.src, pos);
        return a.includes(b);
      }
      if (Array.isArray(a)) return a.some((el) => deepEq(norm(el), b));
      fail(`contains() takes a string or array (got ${typeName(a)})`, ctx.src, pos);
      break;
    }
    default:
      fail(`internal: unhandled function '${name}'`);
  }
}

export function evalExpr(src, scope) {
  const ast = parseExpr(src);
  return ev(ast, { src, scope: scope || {} });
}

// `when` gates and predicates demand an explicit boolean — a bare array or
// count would silently always-run (JS truthiness), the classic weak-author trap.
export function evalBool(src, scope) {
  const v = evalExpr(src, scope);
  if (typeof v !== "boolean") {
    fail(`the expression must yield true/false (got ${typeName(v)}) — write a comparison like length(value) > 0`, src);
  }
  return v;
}

// Every scope identifier the expression reads, first appearance order —
// validation checks these against what its context will actually bind
// (compute: deps/item; when: value/item) so misspellings die at validate time.
export function collectIdents(src) {
  const ast = parseExpr(src);
  const names = [];
  const seen = new Set();
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.k === "id" && !seen.has(n.name)) {
      seen.add(n.name);
      names.push(n.name);
    }
    for (const key of ["obj", "key", "l", "r", "e"]) {
      if (n[key] && typeof n[key] === "object") walk(n[key]);
    }
    if (Array.isArray(n.args)) n.args.forEach(walk);
  })(ast);
  return names;
}

// Static walk for manifest validation: which task ids does this expression
// read via deps, and does it use any form we cannot check statically?
export function collectDepRefs(src) {
  const ast = parseExpr(src);
  const refs = [];
  const seen = new Set();
  let dynamic = false;
  const add = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(id);
    }
  };
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.k === "mem" && n.obj.k === "id" && n.obj.name === "deps") {
      if (!n.computed) add(n.key);
      else if (n.key.k === "lit" && typeof n.key.v === "string") add(n.key.v);
      else {
        dynamic = true;
        walk(n.key);
      }
      return; // the deps identifier itself is accounted for
    }
    if (n.k === "id" && n.name === "deps") {
      dynamic = true;
      return;
    }
    for (const key of ["obj", "key", "l", "r", "e"]) {
      if (n[key] && typeof n[key] === "object") walk(n[key]);
    }
    if (Array.isArray(n.args)) n.args.forEach(walk);
  })(ast);
  return { refs, dynamic };
}
