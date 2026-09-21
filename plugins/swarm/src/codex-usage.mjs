import { providerUsageSnapshot } from "./contracts.mjs";
import { codexExhausted } from "./usage.mjs";
import { createCodexAppServerClient } from "./codex.mjs";

export const CODEX_RATE_LIMITS_METHOD = "account/rateLimits/read";
export const CODEX_RATE_LIMITS_UPDATED_METHOD = "account/rateLimits/updated";
export const CODEX_ACCOUNT_USAGE_METHOD = "account/usage/read";

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function isoNow(value = Date.now()) {
  const candidate = typeof value === "function" ? value() : value;
  if (typeof candidate === "string") return new Date(candidate).toISOString();
  if (candidate instanceof Date) return candidate.toISOString();
  return new Date(candidate).toISOString();
}

function configForCodex(config = {}) {
  return config?.providers?.codex || config?.codex || config;
}

function sourceObject(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function limitEntries(payload) {
  const value = sourceObject(payload);
  const byId = value.rateLimitsByLimitId ?? value.rate_limits_by_limit_id;
  if (byId && typeof byId === "object" && !Array.isArray(byId)) {
    return Object.entries(byId).map(([id, entry]) => ({ id, entry: sourceObject(entry) }));
  }
  const list = value.rateLimits ?? value.rate_limits;
  if (Array.isArray(list)) {
    return list.map((entry, index) => ({
      id: entry?.limitId ?? entry?.limit_id ?? entry?.id ?? String(index),
      entry: sourceObject(entry),
    }));
  }
  if (Array.isArray(payload)) return payload.map((entry, index) => ({ id: entry?.limitId ?? entry?.id ?? String(index), entry: sourceObject(entry) }));
  return [];
}

export function normalizeCodexRateLimitBuckets(payload) {
  return limitEntries(payload).map(({ id, entry }) => ({
    ...clone(entry),
    kind: "rate-limit",
    limitId: entry.limitId ?? entry.limit_id ?? id,
  }));
}

export function normalizeCodexRateLimits(payload, {
  asOf = Date.now(),
  provenance = "live",
  source = CODEX_RATE_LIMITS_METHOD,
} = {}) {
  return providerUsageSnapshot({
    provider: "codex",
    buckets: normalizeCodexRateLimitBuckets(payload),
    source,
    provenance,
    asOf: isoNow(asOf),
  });
}

function accountUsageBucket(payload) {
  const value = sourceObject(payload);
  return {
    ...clone(value),
    kind: "account-usage",
    summary: clone(value.summary ?? value.accountSummary ?? value.account_summary ?? null),
    dailyUsageBuckets: clone(value.dailyUsageBuckets ?? value.daily_usage_buckets ?? value.dailyUsage ?? value.daily_usage ?? null),
  };
}

export function normalizeCodexAccountUsage(payload, { asOf = Date.now(), provenance = "live" } = {}) {
  return providerUsageSnapshot({
    provider: "codex",
    buckets: [accountUsageBucket(payload)],
    source: CODEX_ACCOUNT_USAGE_METHOD,
    provenance,
    asOf: isoNow(asOf),
  });
}

export const normalizeRateLimits = normalizeCodexRateLimits;
export const normalizeAccountUsage = normalizeCodexAccountUsage;

async function makeClient(config, options = {}) {
  if (options.client) return { client: options.client, owned: false };
  if (options.clientFactory) {
    return { client: await options.clientFactory({ config, ...options }), owned: true };
  }
  return {
    client: createCodexAppServerClient({
      config,
      ...options,
      executable: options.executable || configForCodex(config).path,
      args: options.args || configForCodex(config).appServerArgs,
    }),
    owned: true,
  };
}

async function initialize(client, config, options = {}) {
  if (typeof client.initialize === "function") return client.initialize(options.clientInfo || { config });
  return undefined;
}

async function request(client, method, params = {}) {
  if (typeof client.request === "function") return client.request(method, params);
  if (typeof client.call === "function") return client.call(method, params);
  throw new Error("Codex app-server client must expose request() or call()");
}

function notificationPayload(message) {
  return message?.params?.result ?? message?.params?.data ?? message?.params ?? {};
}

function hasRateLimitPayload(payload) {
  const value = sourceObject(payload);
  return Object.hasOwn(value, "rateLimitsByLimitId") || Object.hasOwn(value, "rate_limits_by_limit_id") ||
    Object.hasOwn(value, "rateLimits") || Object.hasOwn(value, "rate_limits");
}

export function subscribeCodexRateLimitUpdates(client, { onUpdate, onError, now = Date.now } = {}) {
  if (!client || typeof client.subscribe !== "function") {
    throw new Error("Codex app-server client must expose subscribe() for rate-limit updates");
  }
  // onError is optional, and a failure with nowhere to go died in silence —
  // indistinguishable from a subscription with nothing to say. A caller that
  // supplies one is still the only receiver.
  const report = onError || ((error) => {
    process.emitWarning(`codex rate-limit update failed: ${error?.message || String(error)}`);
  });
  return client.subscribe((message) => {
    if (message?.method !== CODEX_RATE_LIMITS_UPDATED_METHOD) return;
    const direct = notificationPayload(message);
    const source = hasRateLimitPayload(direct) ? CODEX_RATE_LIMITS_UPDATED_METHOD : CODEX_RATE_LIMITS_METHOD;
    const payload = hasRateLimitPayload(direct)
      ? Promise.resolve(direct)
      : request(client, CODEX_RATE_LIMITS_METHOD);
    payload
      .then((value) => onUpdate?.(normalizeCodexRateLimits(value, { asOf: now, source })))
      .catch(report);
  });
}

export async function readCodexRateLimits(config = {}, options = {}) {
  const { client, owned } = await makeClient(config, options);
  try {
    await initialize(client, config, options);
    const payload = await request(client, CODEX_RATE_LIMITS_METHOD, options.rateLimitsParams || {});
    return normalizeCodexRateLimits(payload, { asOf: options.now || Date.now, provenance: "live" });
  } finally {
    if (owned) await client.close?.();
  }
}

export async function readCodexAccountUsage(config = {}, options = {}) {
  const { client, owned } = await makeClient(config, options);
  try {
    await initialize(client, config, options);
    const payload = await request(client, CODEX_ACCOUNT_USAGE_METHOD, options.accountUsageParams || {});
    return normalizeCodexAccountUsage(payload, { asOf: options.now || Date.now, provenance: "live" });
  } finally {
    if (owned) await client.close?.();
  }
}

// Which endpoint a failure came from, so the caveat can name it. A bare error
// message from the app-server rarely says which read it belonged to.
function failureReason({ method, error }) {
  const text = error?.message || String(error);
  return method ? `${method}: ${text}` : text;
}

function combineSnapshots(rateLimits, accountUsage, asOf, failure) {
  const rateLimitBuckets = rateLimits?.buckets || [];
  const reason = failure ? failureReason(failure) : null;
  return providerUsageSnapshot({
    provider: "codex",
    buckets: [
      ...rateLimitBuckets,
      ...(accountUsage?.buckets || []),
      // The failed half rides as a bucket, not a silent gap. `codexLimitBuckets`
      // skips a non-rate-limit kind, so it never becomes a quota bar.
      ...(reason ? [{ kind: "unavailable", reason }] : []),
    ],
    source: "codex-app-server",
    // `partial` — this process did fetch, and lost half. `live` would render the
    // caveatless reading the banner suppresses for exactly the wrong reason.
    provenance: reason ? "partial" : "live",
    ...(reason ? { reason } : {}),
    // Rate limits are the dispatch-relevant half; account usage is a measurement,
    // so a failed account read must not weaken the gate.
    exhausted: codexExhausted(rateLimitBuckets),
    asOf: isoNow(asOf),
  });
}

export async function readCodexUsage(config = {}, options = {}) {
  const asOf = options.now || Date.now;
  const { client, owned } = await makeClient(config, options);
  let rateLimits;
  let accountUsage;
  let failure;
  try {
    await initialize(client, config, options);
    const [limitsResult, usageResult] = await Promise.allSettled([
      request(client, CODEX_RATE_LIMITS_METHOD, options.rateLimitsParams || {}),
      request(client, CODEX_ACCOUNT_USAGE_METHOD, options.accountUsageParams || {}),
    ]);
    if (limitsResult.status === "fulfilled") rateLimits = normalizeCodexRateLimits(limitsResult.value, { asOf, provenance: "live" });
    else failure = { method: CODEX_RATE_LIMITS_METHOD, error: limitsResult.reason };
    if (usageResult.status === "fulfilled") accountUsage = normalizeCodexAccountUsage(usageResult.value, { asOf, provenance: "live" });
    else failure ||= { method: CODEX_ACCOUNT_USAGE_METHOD, error: usageResult.reason };
    if (!rateLimits && !accountUsage) throw failure?.error || new Error("Codex usage endpoints returned no data");
    return combineSnapshots(rateLimits, accountUsage, asOf, failure);
  } catch (error) {
    // Total failure: no half to mark, so the reading is `none` and names the raw
    // error — there is no surviving half for an endpoint name to disambiguate.
    failure ||= { method: null, error };
    const thrown = failure.error ?? failure;
    return providerUsageSnapshot({
      provider: "codex",
      buckets: [{ kind: "unavailable", reason: thrown?.message || String(thrown) }],
      source: "codex-app-server",
      provenance: "none",
      asOf: isoNow(asOf),
    });
  } finally {
    if (owned) await client.close?.();
  }
}

export const getCodexUsage = readCodexUsage;

export function createCodexUsageAdapter(options = {}) {
  return {
    readUsage(context = {}) {
        return readCodexUsage(context.config || context.cfg || {}, { ...options, ...context });
      },
    subscribeRateLimits(client, context = {}) {
      return subscribeCodexRateLimitUpdates(client, context);
    },
  };
}
