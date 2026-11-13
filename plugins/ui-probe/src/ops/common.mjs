// Primitives every op judge shares: the failure it throws, value matching, and polling.

export const POLL_MS = 50;
export const ASSERT_TIMEOUT_MS = 5000;

export class StepFailure extends Error {
  constructor(outcome, failure = null, message = outcome, extra = {}) {
    super(message);
    this.outcome = outcome;
    this.failure = failure;
    this.extra = extra;
  }
}

export const q = (value) => JSON.stringify(value);

export function absolute(url, baseUrl) {
  if (/^https?:\/\//.test(url)) return url;
  if (!baseUrl) throw new Error(`relative url ${q(url)} needs baseUrl in the config`);
  return `${baseUrl.replace(/\/+$/, "")}${url}`;
}

export function near(actual, expected, tolerance = 0) {
  return Math.abs(actual - expected) <= tolerance;
}

export function matches(actual, expected, tolerance = 0) {
  const a = String(actual).trim();
  const e = String(expected).trim();
  if (a !== "" && e !== "" && Number.isFinite(Number(a)) && Number.isFinite(Number(e))) {
    return near(Number(a), Number(e), tolerance);
  }
  return a === e;
}

export async function pollUntil(attempt, timeoutMs, { _sleep, now }) {
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

export function inconclusive(error) {
  return error instanceof StepFailure ? error : new StepFailure("inconclusive", null, error?.message ?? String(error));
}
