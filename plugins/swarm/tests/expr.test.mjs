import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { parseExpr, evalExpr, evalBool, collectDepRefs, collectIdents, ExprError, MAX_EXPR_LEN } from "../src/expr.mjs";

// The expression language's full contract lives here. Error-message asserts
// are load-bearing: validation is the teaching surface (authorability bar),
// so every error must name what failed, echo the source with a caret, and
// hint the fix where one exists.

function parseFails(src, ...res) {
  try {
    parseExpr(src);
  } catch (e) {
    ok(e instanceof ExprError, `expected ExprError, got ${e?.constructor?.name}: ${e?.message}`);
    for (const re of res) ok(re.test(e.message), `expected ${re} in:\n${e.message}`);
    return e;
  }
  throw new Error(`expected '${src}' to fail parsing`);
}

function evalFails(src, scope, ...res) {
  try {
    evalExpr(src, scope);
  } catch (e) {
    ok(e instanceof ExprError, `expected ExprError, got ${e?.constructor?.name}: ${e?.message}`);
    for (const re of res) ok(re.test(e.message), `expected ${re} in:\n${e.message}`);
    return e;
  }
  throw new Error(`expected '${src}' to fail evaluating`);
}

// ── literals & identifiers ────────────────────────────────────────────────────

test("literals: numbers, strings in both quotes with escapes, booleans, null", () => {
  equal(evalExpr("42", {}), 42);
  equal(evalExpr("3.14", {}), 3.14);
  equal(evalExpr("'it\\'s'", {}), "it's");
  equal(evalExpr('"say \\"hi\\""', {}), 'say "hi"');
  equal(evalExpr("'a\\\\b'", {}), "a\\b");
  equal(evalExpr("true", {}), true);
  equal(evalExpr("false", {}), false);
  equal(evalExpr("null", {}), null);
});

test("identifiers resolve from scope; unknown identifier lists what is available", () => {
  equal(evalExpr("value", { value: 7 }), 7);
  evalFails("sites", { value: 1 }, /unknown identifier 'sites'/, /value/);
});

// ── member access ─────────────────────────────────────────────────────────────

test("dot access reads object fields; missing key is null so the == null idiom works", () => {
  equal(evalExpr("value.n", { value: { n: 5 } }), 5);
  equal(evalExpr("value.missing == null", { value: {} }), true);
  equal(evalExpr("value.missing != null", { value: {} }), false);
});

test("bracket access: string key, dashed key, numeric index, computed index", () => {
  equal(evalExpr("value['a-b']", { value: { "a-b": 3 } }), 3);
  equal(evalExpr("value.arr[0]", { value: { arr: [9, 8] } }), 9);
  equal(evalExpr("value.arr[value.i]", { value: { arr: [9, 8], i: 1 } }), 8);
});

test("out-of-range index is null; non-integer index errors", () => {
  equal(evalExpr("value.arr[9] == null", { value: { arr: [1] } }), true);
  evalFails("value.arr[1.5]", { value: { arr: [1, 2] } }, /integer/);
});

test("member access on null errors and names the failing segment", () => {
  evalFails("value.a.b", { value: {} }, /cannot access/, /\.b/, /null/);
});

test("arrays and strings have no fields — errors redirect to length()", () => {
  evalFails("value.arr.length", { value: { arr: [1, 2] } }, /length\(/);
  evalFails("value.s[0]", { value: { s: "abc" } }, /string/, /length\(|contains\(/);
});

test("only own properties resolve — prototype/constructor lookups are null", () => {
  equal(evalExpr("value['__proto__'] == null", { value: {} }), true);
  equal(evalExpr("value['constructor'] == null", { value: {} }), true);
});

// ── comparison & logic ────────────────────────────────────────────────────────

test("equality is strict (no coercion) and deep for arrays/objects", () => {
  equal(evalExpr("5 == '5'", {}), false);
  equal(evalExpr("5 != '5'", {}), true);
  equal(evalExpr("null == null", {}), true);
  equal(evalExpr("value.a == value.b", { value: { a: [1, { x: 2 }], b: [1, { x: 2 }] } }), true);
  equal(evalExpr("value.a == value.b", { value: { a: [1, { x: 2 }], b: [1, { x: 3 }] } }), false);
});

test("ordering compares numbers only", () => {
  equal(evalExpr("2 > 1", {}), true);
  equal(evalExpr("2 <= 1", {}), false);
  evalFails("'a' < 'b'", {}, /number/);
  evalFails("null < 1", {}, /number/);
});

test("&& and || require booleans and short-circuit", () => {
  equal(evalExpr("true && false", {}), false);
  equal(evalExpr("false || true", {}), true);
  // short-circuit: the right side would error if evaluated
  equal(evalExpr("false && value.x > 1", { value: {} }), false);
  equal(evalExpr("true || value.x > 1", { value: {} }), true);
  evalFails("1 && true", {}, /true\/false/, /&&/);
});

test("! requires a boolean operand", () => {
  equal(evalExpr("!(value.n > 0)", { value: { n: 1 } }), false);
  evalFails("!value.n", { value: { n: 1 } }, /true\/false|boolean/);
});

test("unary minus needs a number", () => {
  equal(evalExpr("-3 < 0", {}), true);
  evalFails("-value.s", { value: { s: "a" } }, /number/);
});

test("arithmetic operators are rejected with a teaching error", () => {
  parseFails("1 + 2", /arithmetic/, /sum\(|comparison/);
  parseFails("value.n * 2", /arithmetic/);
});

test("chained comparisons are rejected and suggest &&", () => {
  parseFails("1 < 2 < 3", /&&/);
});

// ── functions ─────────────────────────────────────────────────────────────────

test("length() counts string chars and array elements; errors elsewhere", () => {
  equal(evalExpr("length('abc')", {}), 3);
  equal(evalExpr("length(value.sites)", { value: { sites: [1, 2] } }), 2);
  evalFails("length(value)", { value: 5 }, /length\(/, /string or array/);
  evalFails("length(null)", {}, /length\(/);
});

test("count(): bare counts, with predicate filters; predicate must be boolean", () => {
  equal(evalExpr("count(value.xs)", { value: { xs: [1, 2, 3] } }), 3);
  equal(evalExpr("count(value.xs, item > 1)", { value: { xs: [1, 2, 3] } }), 2);
  evalFails("count(value.xs, item)", { value: { xs: [1] } }, /true\/false/);
});

test("filter() returns the matching elements", () => {
  deepEqual(evalExpr("filter(value.xs, item > 1)", { value: { xs: [1, 2, 3] } }), [2, 3]);
});

test("nested predicates: item binds innermost", () => {
  equal(
    evalExpr("count(value.groups, count(item.rows) > 0)", { value: { groups: [{ rows: [1, 2] }, { rows: [] }] } }),
    1
  );
  deepEqual(
    evalExpr("filter(value.nested, count(item, item > 10) > 0)", { value: { nested: [[5], [20]] } }),
    [[20]]
  );
});

test("unique_by() dedupes objects by key, first occurrence wins", () => {
  deepEqual(
    evalExpr("unique_by(value.xs, 'f')", { value: { xs: [{ f: "a", n: 1 }, { f: "a", n: 2 }, { f: "b" }] } }),
    [{ f: "a", n: 1 }, { f: "b" }]
  );
  // elements missing the key group together under null
  deepEqual(
    evalExpr("unique_by(value.xs, 'f')", { value: { xs: [{ f: "a" }, { g: 1 }, { h: 2 }] } }),
    [{ f: "a" }, { g: 1 }]
  );
  evalFails("unique_by(value.xs, 'f')", { value: { xs: [1, 2] } }, /unique_by/, /object/);
});

test("flatten() flattens exactly one level", () => {
  deepEqual(evalExpr("flatten(value.xs)", { value: { xs: [[1, 2], [3], [4, [5]]] } }), [1, 2, 3, 4, [5]]);
  deepEqual(evalExpr("flatten(value.xs)", { value: { xs: [1, [2]] } }), [1, 2]);
  evalFails("flatten('x')", {}, /flatten/, /array/);
});

test("min/max/sum over number arrays; sum([]) is 0; min/max([]) error", () => {
  equal(evalExpr("min(value.xs)", { value: { xs: [3, 1, 2] } }), 1);
  equal(evalExpr("max(value.xs)", { value: { xs: [3, 1, 2] } }), 3);
  equal(evalExpr("sum(value.xs)", { value: { xs: [1, 2, 3] } }), 6);
  equal(evalExpr("sum(value.xs)", { value: { xs: [] } }), 0);
  evalFails("min(value.xs)", { value: { xs: [] } }, /min\(/, /empty/);
  evalFails("sum(value.xs)", { value: { xs: [1, "a"] } }, /sum\(/, /number/);
});

test("contains(): substring on strings, deep membership on arrays", () => {
  equal(evalExpr("contains('hello world', 'lo w')", {}), true);
  equal(evalExpr("contains('hello', 'z')", {}), false);
  equal(evalExpr("contains(value.xs, 2)", { value: { xs: [1, 2, 3] } }), true);
  equal(evalExpr("contains(value.xs, value.probe)", { value: { xs: [{ a: 1 }], probe: { a: 1 } } }), true);
  evalFails("contains(5, 1)", {}, /contains\(/);
});

test("unknown function names the table", () => {
  parseFails("nope(1)", /unknown function 'nope'/, /length, count, unique_by, filter, flatten, min, max, sum, contains/);
});

test("arity errors name the function and the expected count", () => {
  parseFails("length()", /length\(\)/, /1 argument/);
  parseFails("length(1, 2)", /length\(\)/, /1 argument/);
  parseFails("unique_by(value)", /unique_by\(\)/, /2 arguments/);
});

// ── parse errors, caret quality, limits ───────────────────────────────────────

test("unterminated string / unclosed paren / unclosed bracket all carry carets", () => {
  ok(parseFails("'abc", /unterminated/).message.includes("^"));
  ok(parseFails("length(value", /expected '\)'/).message.includes("^"));
  ok(parseFails("value[0", /expected '\]'/).message.includes("^"));
});

test("trailing tokens rejected", () => {
  parseFails("true extra", /unexpected/);
});

test("empty expressions rejected", () => {
  parseFails("", /empty/);
  parseFails("   ", /empty/);
});

test("unexpected characters are named", () => {
  parseFails("value @ 1", /unexpected character '@'/);
});

test("expressions over the length cap are rejected up front", () => {
  equal(MAX_EXPR_LEN, 500);
  parseFails("'" + "x".repeat(600) + "'", /500/);
});

test("errors echo the source and point a caret at the failure", () => {
  const e = parseFails("nope(1)", /nope/);
  ok(e.message.includes("nope(1)"), `source echo missing:\n${e.message}`);
  ok(e.message.includes("^"), `caret missing:\n${e.message}`);
});

test("parseExpr returns a reusable AST for valid expressions", () => {
  ok(parseExpr("length(value) > 0"));
});

// ── deps access & static dep collection ───────────────────────────────────────

test("deps: literal access works via brackets and dots; unknown id lists declared ids", () => {
  equal(evalExpr("deps['find-sites'].n", { deps: { "find-sites": { n: 4 } } }), 4);
  equal(evalExpr("deps.scan.n", { deps: { scan: { n: 2 } } }), 2);
  evalFails("deps['ghost'].n", { deps: { scan: 1, fix: 2 } }, /ghost/, /scan, fix/);
});

test("collectDepRefs: literal refs collected in order, deduped; computed or bare deps is dynamic", () => {
  deepEqual(collectDepRefs("unique_by(deps['find-sites'].sites, 'file')"), { refs: ["find-sites"], dynamic: false });
  deepEqual(collectDepRefs("deps.a.n > 0 && deps['b'].m == deps['a'].k"), { refs: ["a", "b"], dynamic: false });
  deepEqual(collectDepRefs("length(value) > 3"), { refs: [], dynamic: false });
  equal(collectDepRefs("deps[value.k]").dynamic, true);
  equal(collectDepRefs("length(deps) > 0").dynamic, true);
});

test("collectIdents lists scope roots in first-appearance order, deduped", () => {
  deepEqual(collectIdents("length(value) > 0 && count(deps.a.xs, item > 2) > 1"), ["value", "deps", "item"]);
  deepEqual(collectIdents("1 == 1"), []);
});

// ── evalBool & raw values ─────────────────────────────────────────────────────

test("evalBool enforces a boolean result with a fix hint", () => {
  equal(evalBool("length(value) > 2", { value: [1, 2, 3] }), true);
  equal(evalBool("length(value) > 9", { value: [1, 2, 3] }), false);
  try {
    evalBool("value.sites", { value: { sites: [1] } });
    throw new Error("expected evalBool to throw");
  } catch (e) {
    ok(e instanceof ExprError, String(e));
    ok(/true\/false/.test(e.message), e.message);
    ok(/length\(/.test(e.message), e.message);
  }
});

test("evalExpr returns raw JSON values for the compute path", () => {
  deepEqual(
    evalExpr("filter(deps.scan.sites, item.line > 10)", { deps: { scan: { sites: [{ line: 5 }, { line: 20 }] } } }),
    [{ line: 20 }]
  );
});
