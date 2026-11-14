// expect_json: GET a URL and compare the value at a dotted path.

import { StepFailure, absolute, q } from "./common.mjs";

function readPath(value, path) {
  const segments = Array.isArray(path) ? path : String(path).split(".");
  return segments.reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function sameValue(actual, expected) {
  if (actual === undefined || expected === undefined) return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export async function expectJson(args, state) {
  const url = absolute(args.url, state.baseUrl);
  // AbortSignal.timeout's timer is unref'd, so a fetch stub (or a quiet network) would let Node
  // exit before the abort could fire. A ref'd timer keeps the loop alive; it is cleared on settle.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    state.fetchTimeoutMs,
  );
  let response;
  try {
    response = await state._fetch(url, { signal: controller.signal });
  } catch (error) {
    throw new StepFailure("inconclusive", null, `GET ${url} failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
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
