// Polling assertions: each retries until the condition holds or the timeout expires.

import { evaluate } from "../cdp.mjs";
import { boxOf, queryIds } from "./interaction.mjs";
import {
  ASSERT_TIMEOUT_MS, StepFailure, inconclusive, matches, near, pollUntil, q,
} from "./common.mjs";
import { expectCssOver } from "./over.mjs";

const VISIBLE_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  // display: contents has no box of its own, so a child's box is the only evidence it renders.
  const visible = (node) => {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return true;
    return style.display === "contents" && Array.from(node.children).some(visible);
  };
  return { found: true, visible: visible(el) };
})()`;

const CSS_JS = (selector, property) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  return { found: true, value: getComputedStyle(el).getPropertyValue(${q(property)}) };
})()`;

const TEXT_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  return { found: true, value: el.textContent || "" };
})()`;

export async function expectVisible(args, state) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const result = await pollUntil(async () => {
    const seen = await evaluate(state.cdp, VISIBLE_JS(args.target));
    if (!seen.found) return { ok: false, found: false, measured: null };
    return { ok: seen.visible, found: true, measured: seen.visible };
  }, timeout, state);
  if (result.ok) return { measured: true, expected: true };
  if (result.error) throw inconclusive(result.error);
  if (!result.found) throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected: true });
  throw new StepFailure("failed", null, `${args.target} is not visible`, { measured: false, expected: true });
}

export async function expectHidden(args, state) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const result = await pollUntil(async () => {
    const seen = await evaluate(state.cdp, VISIBLE_JS(args.target));
    if (!seen.found) return { ok: true, measured: false };
    return { ok: !seen.visible, measured: !seen.visible };
  }, timeout, state);
  if (result.ok) return { measured: true, expected: true };
  if (result.error) throw inconclusive(result.error);
  throw new StepFailure("failed", null, `${args.target} is still visible`, { measured: false, expected: true });
}

export async function expectWidths(args, state) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const expected = args.equals;
  const uniform = !Array.isArray(expected) || expected.length === 1;
  const wanted = uniform ? [].concat(expected)[0] : expected;

  const result = await pollUntil(async () => {
    const nodeIds = await queryIds(state.cdp, args.target);
    if (nodeIds.length === 0) return { ok: false, found: false, measured: [] };
    const widths = [];
    for (const nodeId of nodeIds) widths.push((await boxOf(state.cdp, nodeId)).width);
    const ok = uniform
      ? widths.every((width) => near(width, wanted, args.tolerance))
      : widths.length === expected.length && widths.every((width, i) => near(width, expected[i], args.tolerance));
    return { ok, found: true, measured: widths };
  }, timeout, state);

  if (result.ok) return { measured: result.measured, expected };
  if (result.error) throw inconclusive(result.error);
  if (!result.found) throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: [], expected });
  throw new StepFailure("failed", null, `widths [${result.measured.join(", ")}] do not match ${q(expected)}`, {
    measured: result.measured, expected,
  });
}

export async function expectCss(args, state) {
  if (args.over) return expectCssOver(args, state);
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const result = await pollUntil(async () => {
    const read = await evaluate(state.cdp, CSS_JS(args.target, args.property));
    if (!read.found) return { ok: false, found: false, measured: null };
    return { ok: matches(read.value, args.equals, args.tolerance), found: true, measured: read.value };
  }, timeout, state);

  if (result.ok) return { measured: result.measured, expected: args.equals };
  if (result.error) throw inconclusive(result.error);
  if (!result.found) throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected: args.equals });
  throw new StepFailure("failed", null, `${args.target} ${args.property} = ${q(result.measured)}`, {
    measured: result.measured, expected: args.equals,
  });
}

export async function expectText(args, state) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const result = await pollUntil(async () => {
    const read = await evaluate(state.cdp, TEXT_JS(args.target));
    if (!read.found) return { ok: false, found: false, measured: null };
    return { ok: read.value.trim() === String(args.equals).trim(), found: true, measured: read.value.trim() };
  }, timeout, state);

  if (result.ok) return { measured: result.measured, expected: args.equals };
  if (result.error) throw inconclusive(result.error);
  if (!result.found) throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected: args.equals });
  throw new StepFailure("failed", null, `${args.target} text = ${q(result.measured)}`, { measured: result.measured, expected: args.equals });
}
