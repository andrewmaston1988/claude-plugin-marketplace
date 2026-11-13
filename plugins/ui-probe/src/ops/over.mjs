// The `over` sampler: one computed-style read per animation frame across a time window.

import { evaluate } from "../cdp.mjs";
import { StepFailure, q } from "./common.mjs";

// One sample per animation frame for `over` ms. A discrete flip (display none -> flex) leaves no
// animation to read, so a frame series is the only instrument that sees when it happened.
function rafJs(selector, property, expected, tolerance, over) {
  return `(async () => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  const expectedNum = Number(${q(expected)});
  const tolerance = ${Number(tolerance ?? 0)};
  const same = (value) => {
    const text = String(value).trim();
    if (text !== "" && Number.isFinite(expectedNum) && Number.isFinite(Number(text))) {
      return Math.abs(Number(text) - expectedNum) <= tolerance;
    }
    return text === String(${q(String(expected))}).trim();
  };
  const frames = [];
  let matched = null;
  const started = performance.now();
  await new Promise((done) => {
    const frame = (now) => {
      const value = getComputedStyle(el).getPropertyValue(${q(property)});
      const index = frames.length;
      const ms = Math.round((now - started) * 10) / 10;
      frames.push({ index, ms, value });
      if (!matched && same(value)) matched = { index, ms, value };
      if (now - started < ${Number(over)}) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  return { found: true, frames: frames.length, matched };
})()`;
}

export async function expectCssOver(args, state) {
  const result = await evaluate(state.cdp, rafJs(args.target, args.property, args.equals, args.tolerance, args.over));
  if (!result) throw new StepFailure("inconclusive", null, `no frame series for ${args.target}`);
  if (!result.found) throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected: args.equals });
  if (result.frames < 2) {
    throw new StepFailure("inconclusive", null, `only ${result.frames} frame(s) in the ${args.over}ms window`, {
      measured: result.frames, expected: args.equals,
    });
  }
  if (!result.matched) {
    throw new StepFailure("failed", null, `${args.target} ${args.property} never matched ${q(args.equals)} in ${args.over}ms`, {
      measured: null, expected: args.equals, frame: { index: -1, frames: result.frames },
    });
  }
  return { measured: result.matched.value, expected: args.equals, frame: { index: result.matched.index, ms: result.matched.ms } };
}
