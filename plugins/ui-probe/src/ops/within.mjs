// expect_within: every match's box must sit inside a box, and stay there for holdMs of frames.
// A focus scale lands after the first in-bounds sample, so a first-sample pass would miss it.

import { evaluate } from "../cdp.mjs";
import { ASSERT_TIMEOUT_MS, StepFailure, inconclusive, q } from "./common.mjs";

const DEFAULT_HOLD_MS = 300;
const SAFE_FRACTION = 0.05;

function withinJs(selector, box, timeoutMs, holdMs) {
  return `(async () => {
  const selector = ${q(selector)};
  const wanted = ${JSON.stringify(box)};
  const deadline = performance.now() + ${Number(timeoutMs)};
  const readBox = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const safe = () => ({
    left: innerWidth * ${SAFE_FRACTION}, top: innerHeight * ${SAFE_FRACTION},
    right: innerWidth * ${1 - SAFE_FRACTION}, bottom: innerHeight * ${1 - SAFE_FRACTION},
  });
  const frame = () => new Promise((done) => requestAnimationFrame(done));
  const outside = (boxes, limit) => boxes.find((b) => b.left < limit.left || b.top < limit.top
    || b.right > limit.right || b.bottom > limit.bottom) || null;

  let boxes = [];
  let limit = null;
  let held = null;
  for (;;) {
    boxes = Array.from(document.querySelectorAll(selector)).map(readBox);
    limit = wanted === "safe" ? safe() : wanted;
    if (boxes.length && !outside(boxes, limit)) { held = boxes; break; }
    if (performance.now() >= deadline) break;
    await frame();
  }
  if (!held) return { found: boxes.length > 0, held: false, measured: boxes, box: limit };

  const holdMs = ${Number(holdMs)};
  const started = performance.now();
  let frames = 0;
  while (holdMs > 0) {
    await frame();
    frames += 1;
    const now = Array.from(document.querySelectorAll(selector)).map(readBox);
    const left = outside(now, limit);
    if (left) return { found: true, held: true, left: true, frames, measured: left, box: limit };
    if (performance.now() - started >= holdMs) break;
  }
  return { found: true, held: true, left: false, frames, measured: held, box: limit };
})()`;
}

export async function expectWithin(args, state) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const holdMs = args.holdMs ?? DEFAULT_HOLD_MS;
  const expected = args.box;

  let result;
  try {
    result = await evaluate(state.cdp, withinJs(args.target, args.box, timeout, holdMs));
  } catch (error) {
    throw inconclusive(error);
  }
  if (!result) throw new StepFailure("inconclusive", null, `no measurement for ${args.target}`);
  if (!result.found) {
    throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected });
  }
  if (result.left) {
    throw new StepFailure("failed", null, `${args.target} left the ${q(expected)} box during the ${holdMs}ms hold`, {
      measured: result.measured, expected, frame: { index: result.frames },
    });
  }
  if (!result.held) {
    throw new StepFailure("failed", null, `${args.target} is outside the ${q(expected)} box`, {
      measured: result.measured[0] ?? null, expected,
    });
  }
  return { measured: result.measured.length === 1 ? result.measured[0] : result.measured, expected, frames: result.frames };
}
