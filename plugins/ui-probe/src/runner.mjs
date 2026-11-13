// Executes the scenario IR over CDP and the network. One record per step, worst step wins.

import { sleep } from "./cdp.mjs";
import { setCookies } from "./auth.mjs";
import { installFetchGuard } from "./guard.mjs";
import { assertsNothing, validate } from "./ir.mjs";
import { StepFailure, absolute, inconclusive, q } from "./ops/common.mjs";
import { OPS } from "./ops/index.mjs";

const LOAD_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 10000;

const EXIT_CODES = { passed: 0, failed: 1, inconclusive: 2, needs_review: 3, invalid: 64 };

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
  ...OPS,
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
