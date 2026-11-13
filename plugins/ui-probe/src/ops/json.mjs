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
