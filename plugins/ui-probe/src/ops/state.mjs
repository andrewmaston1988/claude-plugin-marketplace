// DOM state assertions: a property of the first match, and how many elements match.

import { evaluate } from "../cdp.mjs";
import { ASSERT_TIMEOUT_MS, StepFailure, inconclusive, matches, near, pollUntil, q } from "./common.mjs";
import { expectCountOver, expectPropOver } from "./over.mjs";

const PROP_JS = (selector, property) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  const value = el[${q(property)}];
  if (typeof value === "number" || typeof value === "boolean") return { found: true, value };
  return { found: true, value: value == null ? null : String(value) };
})()`;

const COUNT_JS = (selector) => `(() => ({ found: true, value: document.querySelectorAll(${q(selector)}).length }))()`;

/** equals | gt | lt against one measured value. Booleans and numbers compare as themselves. */
export function compare(args, actual) {
  if ("equals" in args) {
    const wanted = args.equals;
    if (typeof wanted === "boolean" || typeof actual === "boolean") return wanted === actual;
    if (typeof wanted === "number" && typeof actual === "number") return near(actual, wanted, args.tolerance);
    return matches(actual, wanted, args.tolerance);
  }
  const number = Number(actual);
  if (!Number.isFinite(number)) return false;
  if ("gt" in args) return number > args.gt;
  return number < args.lt;
}

function expectedOf(args) {
  if ("equals" in args) return args.equals;
  if ("gt" in args) return { gt: args.gt };
  return { lt: args.lt };
}

async function poll(args, state, expression, label) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const expected = expectedOf(args);
  const result = await pollUntil(async () => {
    const read = await evaluate(state.cdp, expression);
    if (!read.found) return { ok: false, found: false, measured: null };
    return { ok: compare(args, read.value), found: true, measured: read.value };
  }, timeout, state);

  if (result.ok) return { measured: result.measured, expected };
  if (result.error) throw inconclusive(result.error);
  if (!result.found) throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected });
  throw new StepFailure("failed", null, `${label} = ${q(result.measured)}`, { measured: result.measured, expected });
}

export async function expectProp(args, state) {
  if (args.over) return expectPropOver(args, state);
  return poll(args, state, PROP_JS(args.target, args.property), `${args.target} ${args.property}`);
}

export async function expectCount(args, state) {
  if (args.over) return expectCountOver(args, state);
  return poll(args, state, COUNT_JS(args.target), `${args.target} count`);
}
