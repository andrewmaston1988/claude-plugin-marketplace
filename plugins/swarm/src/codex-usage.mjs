import { providerUsageSnapshot } from "./contracts.mjs";
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
  return client.subscribe((message) => {
    if (message?.method !== CODEX_RATE_LIMITS_UPDATED_METHOD) return;
    const direct = notificationPayload(message);
    const source = hasRateLimitPayload(direct) ? CODEX_RATE_LIMITS_UPDATED_METHOD : CODEX_RATE_LIMITS_METHOD;
    const payload = hasRateLimitPayload(direct)
      ? Promise.resolve(direct)
      : request(client, CODEX_RATE_LIMITS_METHOD);
    payload
      .then((value) => onUpdate?.(normalizeCodexRateLimits(value, { asOf: now, source })))
      .catch((error) => onError?.(error));
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

function combineSnapshots(rateLimits, accountUsage, asOf) {
  return providerUsageSnapshot({
    provider: "codex",
    buckets: [...(rateLimits?.buckets || []), ...(accountUsage?.buckets || [])],
    source: "codex-app-server",
    provenance: "live",
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
    else failure = limitsResult.reason;
    if (usageResult.status === "fulfilled") accountUsage = normalizeCodexAccountUsage(usageResult.value, { asOf, provenance: "live" });
    else failure ||= usageResult.reason;
    if (!rateLimits && !accountUsage) throw failure || new Error("Codex usage endpoints returned no data");
    return combineSnapshots(rateLimits, accountUsage, asOf);
  } catch (error) {
    failure ||= error;
    return providerUsageSnapshot({
      provider: "codex",
      buckets: [{ kind: "unavailable", reason: failure?.message || String(failure) }],
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
