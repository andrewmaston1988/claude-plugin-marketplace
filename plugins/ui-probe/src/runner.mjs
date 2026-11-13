// Executes the scenario IR over CDP and the network. One record per step, worst step wins.

import { evaluate, sleep } from "./cdp.mjs";
import { setCookies } from "./auth.mjs";
import { actionAllowed, installFetchGuard } from "./guard.mjs";
import { assertsNothing, validate } from "./ir.mjs";

const POLL_MS = 50;
const ASSERT_TIMEOUT_MS = 5000;
const LOAD_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 10000;

const EXIT_CODES = { passed: 0, failed: 1, inconclusive: 2, needs_review: 3, invalid: 64 };

class StepFailure extends Error {
  constructor(outcome, failure = null, message = outcome, extra = {}) {
    super(message);
    this.outcome = outcome;
    this.failure = failure;
    this.extra = extra;
  }
}

const q = (value) => JSON.stringify(value);

function absolute(url, baseUrl) {
  if (/^https?:\/\//.test(url)) return url;
  if (!baseUrl) throw new Error(`relative url ${q(url)} needs baseUrl in the config`);
  return `${baseUrl.replace(/\/+$/, "")}${url}`;
}

function near(actual, expected, tolerance = 0) {
  return Math.abs(actual - expected) <= tolerance;
}

function matches(actual, expected, tolerance = 0) {
  const a = String(actual).trim();
  const e = String(expected).trim();
  if (a !== "" && e !== "" && Number.isFinite(Number(a)) && Number.isFinite(Number(e))) {
    return near(Number(a), Number(e), tolerance);
  }
  return a === e;
}

const VISIBLE_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return { found: true, display: style.display, visibility: style.visibility, width: box.width, height: box.height };
})()`;

// getBoundingClientRect and elementFromPoint are viewport-relative, so a target below the fold
// reads as covered until it is scrolled to.
const SCROLL_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center", inline: "center" });
  return { found: true };
})()`;

const OBSCURED_JS = (selector) => `(() => {
  const el = document.querySelector(${q(selector)});
  if (!el) return { found: false };
  const box = el.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return { found: true, clear: Boolean(hit) && (hit === el || el.contains(hit)) };
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

/**
 * Navigate and wait for the load event. Resolves once the new document has painted its load;
 * a navigation error or a load that never comes rejects, which the caller reads as inconclusive.
 */
export function navigate(cdp, url, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`load timed out after ${timeoutMs}ms for ${url}`)), timeoutMs);
    const off = cdp.on("Page.loadEventFired", () => finish(resolve));
    cdp.send("Page.navigate", { url }).then(
      (result) => { if (result?.errorText) finish(reject, new Error(`${url}: ${result.errorText}`)); },
      (error) => finish(reject, error),
    );
  });
}

async function queryIds(cdp, selector) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
  return nodeIds || [];
}

async function boxOf(cdp, nodeId) {
  const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
  const quad = model.border || model.content;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: model.width ?? right - left,
    height: model.height ?? bottom - top,
  };
}

async function isConnected(cdp, nodeId) {
  let objectId = null;
  try {
    ({ object: { objectId } } = await cdp.send("DOM.resolveNode", { nodeId }));
  } catch {
    return false;
  }
  try {
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this.isConnected === true; }",
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  } finally {
    try { await cdp.send("Runtime.releaseObject", { objectId }); } catch { /* already collected */ }
  }
}

async function pollUntil(attempt, timeoutMs, { _sleep, now }) {
  const deadline = now() + Math.max(0, timeoutMs);
  for (;;) {
    let value;
    try {
      value = await attempt();
      if (value.ok) return value;
    } catch (error) {
      value = { ok: false, error };
    }
    if (now() >= deadline) return value;
    await _sleep(POLL_MS);
  }
}

function inconclusive(error) {
  return error instanceof StepFailure ? error : new StepFailure("inconclusive", null, error?.message ?? String(error));
}

async function openStep(args, state) {
  const url = absolute(args.url, state.baseUrl);
  try {
    await navigate(state.cdp, url, { timeoutMs: state.loadTimeoutMs });
  } catch (error) {
    throw inconclusive(error);
  }
}

async function viewportStep(args, state) {
  const touch = args.touch === true;
  await state.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: args.width, height: args.height, deviceScaleFactor: args.dpr ?? 1, mobile: touch,
  });
  const touchParams = touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false };
  await state.cdp.send("Emulation.setTouchEmulationEnabled", touchParams);
}

async function dispatch(cdp, op, point, _sleep) {
  if (op === "hover") {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse", button: "none" });
    return;
  }
  if (op === "click") {
    const base = { x: point.x, y: point.y, button: "left", clickCount: 1, pointerType: "mouse" };
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return;
  }
  const touchPoints = [{ x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
  await _sleep(30);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function interact(op, args, state) {
  const nodeIds = await queryIds(state.cdp, args.target);
  if (nodeIds.length === 0) throw new StepFailure("failed", "not_found", `no element for ${args.target}`);
  if (nodeIds.length > 1) throw new StepFailure("failed", "ambiguous_target", `${nodeIds.length} elements match ${args.target}`);

  if (op !== "hover" && !state.allowWrites) {
    const action = await actionAllowed(state.cdp, args.target);
    if (action.found && !action.allowed) {
      const where = action.url ? ` ${action.url}` : "";
      throw new StepFailure("failed", "write_blocked", `${args.target} would submit ${action.method}${where}`);
    }
  }

  await evaluate(state.cdp, SCROLL_JS(args.target));

  let point;
  try {
    point = await boxOf(state.cdp, nodeIds[0]);
  } catch {
    throw new StepFailure("failed", "not_found", `${args.target} has no box to aim at`);
  }
  const hit = await evaluate(state.cdp, OBSCURED_JS(args.target));
  if (hit?.found && !hit.clear) throw new StepFailure("failed", "target_obscured", `${args.target} is covered at its centre`);
  if (!(await isConnected(state.cdp, nodeIds[0]))) throw new StepFailure("failed", "stale_target", `${args.target} left the document before input`);

  await dispatch(state.cdp, op, point, state._sleep);
}

async function expectVisible(args, state) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const result = await pollUntil(async () => {
    const seen = await evaluate(state.cdp, VISIBLE_JS(args.target));
    if (!seen.found) return { ok: false, found: false, measured: null };
    const visible = seen.display !== "none" && seen.visibility !== "hidden" && seen.width > 0 && seen.height > 0;
    return { ok: visible, found: true, measured: visible };
  }, timeout, state);
  if (result.ok) return { measured: true, expected: true };
  if (result.error) throw inconclusive(result.error);
  if (!result.found) throw new StepFailure("failed", "not_found", `no element for ${args.target}`, { measured: null, expected: true });
  throw new StepFailure("failed", null, `${args.target} is not visible`, { measured: false, expected: true });
}

async function expectHidden(args, state) {
  const timeout = args.timeoutMs ?? ASSERT_TIMEOUT_MS;
  const result = await pollUntil(async () => {
    const seen = await evaluate(state.cdp, VISIBLE_JS(args.target));
    if (!seen.found) return { ok: true, measured: false };
    const visible = seen.display !== "none" && seen.visibility !== "hidden" && seen.width > 0 && seen.height > 0;
    return { ok: !visible, measured: !visible };
  }, timeout, state);
  if (result.ok) return { measured: true, expected: true };
  if (result.error) throw inconclusive(result.error);
  throw new StepFailure("failed", null, `${args.target} is still visible`, { measured: false, expected: true });
}

async function expectWidths(args, state) {
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

async function expectCssOver(args, state) {
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

async function expectCss(args, state) {
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

async function expectText(args, state) {
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

function readPath(value, path) {
  const segments = Array.isArray(path) ? path : String(path).split(".");
  return segments.reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function sameValue(actual, expected) {
  if (actual === undefined || expected === undefined) return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function expectJson(args, state) {
  const url = absolute(args.url, state.baseUrl);
  let response;
  try {
    response = await state._fetch(url, { signal: AbortSignal.timeout(state.fetchTimeoutMs) });
  } catch (error) {
    throw new StepFailure("inconclusive", null, `GET ${url} failed: ${error.message}`);
  }
  const status = response.status ?? 0;
  if (status < 200 || status >= 300) throw new StepFailure("inconclusive", null, `GET ${url} returned ${status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new StepFailure("inconclusive", null, `GET ${url} did not return JSON`);
  }
  const actual = readPath(body, args.path);
  if (!sameValue(actual, args.equals)) {
    throw new StepFailure("failed", null, `${args.path} = ${q(actual)}`, { measured: actual ?? null, expected: args.equals });
  }
  return { measured: actual, expected: args.equals };
}

const STEPS = {
  open: openStep,
  viewport: viewportStep,
  hover: (args, state) => interact("hover", args, state),
  click: (args, state) => interact("click", args, state),
  tap: (args, state) => interact("tap", args, state),
  expect_visible: expectVisible,
  expect_hidden: expectHidden,
  expect_widths: expectWidths,
  expect_css: expectCss,
  expect_text: expectText,
  expect_json: expectJson,
};

async function execStep(op, args, state) {
  const step = STEPS[op];
  if (!step) throw new StepFailure("inconclusive", null, `unsupported op ${q(op)}`);
  return (await step(args, state)) ?? {};
}

/**
 * Run a scenario document. `ctx.cdp` is a connected page-level client (or a factory returning
 * one); it is only touched by a browser scenario that has steps to judge. `ctx.guard` lets a
 * caller own the Fetch guard so capture and the scenario share one interception.
 */
export async function run(doc, ctx = {}) {
  const problems = validate(doc);
  if (problems.length) return { outcome: "invalid", steps: [], exitCode: EXIT_CODES.invalid, problems };

  const idle = ctx.requireAssertion === false ? [] : assertsNothing(doc);
  if (idle.length) return { outcome: "needs_review", steps: [], exitCode: EXIT_CODES.needs_review, problems: idle };

  const browser = (doc.backend ?? "browser") === "browser";
  const state = {
    baseUrl: ctx.baseUrl ?? null,
    allowWrites: Boolean(ctx.allowWrites),
    loadTimeoutMs: ctx.loadTimeoutMs ?? LOAD_TIMEOUT_MS,
    fetchTimeoutMs: ctx.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
    _fetch: ctx._fetch ?? fetch,
    _sleep: ctx._sleep ?? sleep,
    now: ctx.now ?? Date.now,
    source: ctx.source ?? doc.id,
    cdp: null,
    guard: ctx.guard ?? null,
    blocked: ctx.blocked ?? [],
  };

  if (browser) {
    state.cdp = typeof ctx.cdp === "function" ? await ctx.cdp() : ctx.cdp;
    if (!state.cdp) throw new Error("run() needs ctx.cdp (a connected CDP client) for a browser scenario");
    await state.cdp.send("Page.enable");
    if (ctx.cookies?.length) {
      const open = doc.steps.map((step) => step.open).find(Boolean);
      const cookieUrl = open && /^https?:\/\//.test(open.url) ? open.url : state.baseUrl;
      if (cookieUrl) await setCookies(state.cdp, ctx.cookies, cookieUrl);
    }
    if (!state.guard) {
      state.guard = await installFetchGuard(state.cdp, { allowWrites: state.allowWrites, blocked: state.blocked });
    }
  }

  const records = [];
  let stopped = false;
  try {
    for (const [index, step] of doc.steps.entries()) {
      const op = Object.keys(step)[0];
      const args = step[op];
      const base = { source: `${state.source}:${index + 1}`, op };
      if (args?.target) base.target = args.target;
      if (stopped) {
        records.push({ ...base, outcome: "not_run", ms: 0 });
        continue;
      }
      const started = state.now();
      try {
        records.push({ ...base, outcome: "passed", ...(await execStep(op, args, state)), ms: state.now() - started });
      } catch (error) {
        const failure = error instanceof StepFailure ? error : inconclusive(error);
        records.push({
          ...base,
          outcome: failure.outcome,
          ...(failure.failure ? { failure: failure.failure } : {}),
          ...failure.extra,
          ms: state.now() - started,
        });
        stopped = true;
      }
    }
  } finally {
    if (state.guard && !ctx.guard) await state.guard.uninstall();
  }

  const outcome = records.some((record) => record.outcome === "failed")
    ? "failed"
    : records.some((record) => record.outcome === "inconclusive") ? "inconclusive" : "passed";
  return { outcome, steps: records, exitCode: EXIT_CODES[outcome], blocked: state.blocked };
}
