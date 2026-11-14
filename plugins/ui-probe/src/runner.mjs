// Executes the scenario IR over CDP and the network. One record per step, worst step wins.

import { sleep } from "./cdp.mjs";
import { setCookies } from "./auth.mjs";
import { installGuard, inTvScope, NO_PROTOCOL } from "./guard.mjs";
import { assertsNothing, expandIncludes, stepLabel, validate } from "./ir.mjs";
import { StepFailure, absolute, inconclusive, q } from "./ops/common.mjs";
import { OPS } from "./ops/index.mjs";

const LOAD_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 10000;
// A TV journey on the desktop device runs at the set's viewport, so one file serves both.
const DESKTOP_TV = { width: 1920, height: 1080, dpr: 1 };

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

const STEPS = {
  open: openStep,
  viewport: viewportStep,
  ...OPS,
};

// The set is 1920x1080 at dpr 1 with no touch. A desktop device stands in for it exactly, so a
// journey that passes here has the same geometry and the same key events as on the TV.
async function emulateDesktopTv(cdp) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: DESKTOP_TV.width, height: DESKTOP_TV.height,
    deviceScaleFactor: DESKTOP_TV.dpr, mobile: false,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

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
  const { doc: scenario, problems: includeProblems } = expandIncludes(doc, { baseDir: ctx.baseDir, file: ctx.file });
  if (includeProblems.length) {
    return { outcome: "invalid", steps: [], exitCode: EXIT_CODES.invalid, problems: includeProblems };
  }
  const problems = validate(scenario);
  if (problems.length) return { outcome: "invalid", steps: [], exitCode: EXIT_CODES.invalid, problems };

  const idle = ctx.requireAssertion === false ? [] : assertsNothing(scenario);
  if (idle.length) return { outcome: "needs_review", steps: [], exitCode: EXIT_CODES.needs_review, problems: idle };

  const backend = scenario.backend ?? "browser";
  const device = ctx.device ?? "desktop";
  const tvScope = inTvScope({ backend, device });
  const browser = backend !== "http";
  const state = {
    baseUrl: ctx.baseUrl ?? null,
    allowWrites: Boolean(ctx.allowWrites),
    loadTimeoutMs: ctx.loadTimeoutMs ?? LOAD_TIMEOUT_MS,
    fetchTimeoutMs: ctx.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
    _fetch: ctx._fetch ?? fetch,
    _sleep: ctx._sleep ?? sleep,
    now: ctx.now ?? Date.now,
    source: ctx.source ?? scenario.id,
    cdp: null,
    guard: ctx.guard ?? null,
    blocked: ctx.blocked ?? [],
  };

  if (browser) {
    state.cdp = typeof ctx.cdp === "function" ? await ctx.cdp() : ctx.cdp;
    if (!state.cdp) throw new Error("run() needs ctx.cdp (a connected CDP client) for a browser scenario");
    await state.cdp.send("Page.enable");
    if (backend === "tv" && device === "desktop") await emulateDesktopTv(state.cdp);
    if (ctx.cookies?.length) {
      const open = scenario.steps.map((step) => step.open).find(Boolean);
      const cookieUrl = open && /^https?:\/\//.test(open.url) ? open.url : state.baseUrl;
      if (cookieUrl) await setCookies(state.cdp, ctx.cookies, cookieUrl);
    }
    if (!state.guard) {
      // The set may serve no protocol at all; on the web a null one is the modern browser.
      const protocol = device === "tv" && ctx.protocol == null ? NO_PROTOCOL : (ctx.protocol ?? null);
      state.guard = await installGuard(state.cdp, protocol, {
        allowWrites: state.allowWrites,
        blocked: state.blocked,
        testOrigin: ctx.testOrigin ?? null,
        tvScope,
      });
    }
  }

  const records = [];
  let stopped = false;
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const op = Object.keys(step)[0];
      const args = step[op];
      const base = { source: stepLabel(step, index, state.source), op };
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
