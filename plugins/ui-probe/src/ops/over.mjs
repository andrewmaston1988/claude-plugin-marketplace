// The `over` sampler: one read per animation frame across a time window.
//
// A discrete flip (display none -> flex) leaves no animation to read, so a frame series is the
// only instrument that sees when it happened. `mode: all` uses the same series to prove nothing
// moved — a debounce or a dwell — which an eventual poll cannot fail.

import { evaluate } from "../cdp.mjs";
import { StepFailure, q } from "./common.mjs";

const READERS = {
  css: (property) => `el ? getComputedStyle(el).getPropertyValue(${q(property)}) : null`,
  text: () => `el ? (el.textContent || "").trim() : null`,
  prop: (property) => `el ? (typeof el[${q(property)}] === "number" || typeof el[${q(property)}] === "boolean"
    ? el[${q(property)}] : String(el[${q(property)}] ?? "")) : null`,
  count: () => "document.querySelectorAll(selector).length",
};

function samplerJs({ selector, read, expected, tolerance, over }) {
  return `(async () => {
  const selector = ${q(selector)};
  const expected = ${JSON.stringify(expected)};
  const tolerance = ${Number(tolerance ?? 0)};
  const same = (value) => {
    if ("equals" in expected) {
      const wanted = expected.equals;
      if (typeof wanted === "boolean" || typeof value === "boolean") return wanted === value;
      if (typeof wanted === "number" && typeof value === "number") return Math.abs(value - wanted) <= tolerance;
      const a = String(value ?? "").trim();
      const b = String(wanted ?? "").trim();
      if (a !== "" && b !== "" && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) {
        return Math.abs(Number(a) - Number(b)) <= tolerance;
      }
      return a === b;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    if ("gt" in expected) return number > expected.gt;
    return number < expected.lt;
  };
  let frames = 0;
  let first = null;
  let firstMiss = null;
  const started = performance.now();
  await new Promise((done) => {
    const frame = (now) => {
      const el = document.querySelector(selector);
      const value = (${read});
      const ok = same(value);
      const ms = Math.round((now - started) * 10) / 10;
      const index = frames;
      frames += 1;
      if (ok) { if (!first) first = { index, ms, value }; }
      else if (!firstMiss) firstMiss = { index, ms, value };
      if (now - started < ${Number(over)}) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  return { matches: document.querySelectorAll(selector).length, frames, first, firstMiss };
})()`;
}

function expectedOf(args) {
  if ("equals" in args) return { equals: args.equals };
  if ("gt" in args) return { gt: args.gt };
  return { lt: args.lt };
}

function labelOf(args, kind) {
  if (kind === "text") return `${args.target} text`;
  if (kind === "count") return `${args.target} count`;
  return `${args.target} ${args.property}`;
}

async function sample(args, state, kind) {
  const read = kind === "count" ? READERS.count() : READERS[kind](args.property);
  const expected = expectedOf(args);
  const result = await evaluate(state.cdp, samplerJs({
    selector: args.target, read, expected, tolerance: args.tolerance, over: args.over,
  }));
  if (!result) throw new StepFailure("inconclusive", null, `no frame series for ${args.target}`);
  const label = labelOf(args, kind);
  if (kind !== "count" && result.matches === 0) {
    throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected: args.equals ?? null });
  }
  if (result.frames < 2) {
    throw new StepFailure("inconclusive", null, `only ${result.frames} frame(s) in the ${args.over}ms window`, {
      measured: result.frames, expected: args.equals ?? null,
    });
  }
  if (args.mode === "all" && result.firstMiss) {
    throw new StepFailure("failed", null, `${label} left ${q(expected)} at frame ${result.firstMiss.index}`, {
      measured: result.firstMiss.value, expected, frame: { index: result.firstMiss.index, ms: result.firstMiss.ms, frames: result.frames },
    });
  }
  if (!result.first) {
    throw new StepFailure("failed", null, `${label} never matched ${q(expected)} in ${args.over}ms`, {
      measured: null, expected, frame: { index: -1, frames: result.frames },
    });
  }
  return { measured: result.first.value, expected, frame: { index: result.first.index, ms: result.first.ms } };
}

export async function expectCssOver(args, state) {
  return sample(args, state, "css");
}

export async function expectTextOver(args, state) {
  return sample(args, state, "text");
}

export async function expectPropOver(args, state) {
  return sample(args, state, "prop");
}

export async function expectCountOver(args, state) {
  return sample(args, state, "count");
}
