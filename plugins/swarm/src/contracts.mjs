const RECORD_FIELDS = {
  ModelDescriptor: {
    required: ["provider", "model", "runner"],
    optional: ["displayName", "efforts", "defaultEffort", "modalities", "isDefault", "availability"],
  },
  ProviderUsageSnapshot: {
    required: ["provider", "buckets", "source", "provenance", "asOf"],
    // `exhausted` is the dispatch gate's field and `reason` the partial-failure
    // caveat's. Both are dropped here in silence if unlisted, which is how a
    // dead gate ships looking committed.
    optional: ["exhausted", "reason"],
  },
  RunnerEvent: {
    required: ["type"],
    optional: ["sessionId", "text", "activity", "usage", "realModel", "terminal", "error"],
  },
  RunResult: {
    required: ["provider", "model", "output", "terminal"],
    optional: ["sessionId", "usage", "realModel", "error"],
  },
  CostObservation: {
    required: ["provider", "model", "unit", "source", "classification", "asOf"],
    optional: ["value"],
  },
  AvailabilityVerdict: {
    required: ["provider", "model", "state", "source", "asOf"],
    optional: ["reason"],
  },
};

export const CLAUDE_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);
export const CONTEXT_WINDOW_1M = "1m";
export const CONTEXT_WINDOWS = new Set([CONTEXT_WINDOW_1M]);
export const COST_CLASSIFICATIONS = new Set(["billed", "api-equivalent estimate", "unpriced"]);
export const AVAILABILITY_STATES = new Set(["available", "unavailable", "unknown"]);
// How a usage reading was obtained. Both directions of the display key off this
// token — the banner suppresses itself for `live`, the headroom gate trusts only
// `live` — so an undeclared token would render as an unverified reading with no
// caveat. `live` this process fetched it, `partial` it fetched half, `cached`
// from a store this process did not fill, `cache` Anthropic's self-healing TTL
// cache, `none` no reading, `unknown` a provider that never declared one.
export const PROVENANCE_STATES = new Set(["live", "partial", "cached", "cache", "none", "unknown"]);
// What makes an ollama model a cloud one. Discovery and the provider descriptor each
// carried their own copy of this.
export const OLLAMA_CLOUD_RE = /(:|-)cloud$/i;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeProvider(provider, recordName) {
  if (!nonEmptyString(provider)) throw new Error(`${recordName} requires non-empty field 'provider'`);
  return provider.trim().toLowerCase();
}

function normalizeModel(model, recordName) {
  if (!nonEmptyString(model)) throw new Error(`${recordName} requires non-empty field 'model'`);
  return model.trim();
}

function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} string`);
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
}

function requireTimestamp(value, name) {
  requireString(value, name);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) {
    throw new Error(`${name} must be an ISO-8601 timestamp`);
  }
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO-8601 timestamp`);
  const calendarDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (calendarDate.getUTCFullYear() !== Number(match[1]) || calendarDate.getUTCMonth() + 1 !== Number(match[2]) || calendarDate.getUTCDate() !== Number(match[3])) {
    throw new Error(`${name} must be an ISO-8601 timestamp`);
  }
}

function requireError(value, name) {
  if (typeof value !== "string") requirePlainObject(value, name);
}

function requireEnum(value, name, allowed) {
  requireString(value, name);
  if (!allowed.has(value)) throw new Error(`${name} must be one of: ${[...allowed].join(", ")}`);
}

export function isClaudeModel(model) {
  const value = String(model || "").toLowerCase();
  return value.startsWith("claude-") || CLAUDE_ALIASES.has(value);
}

// The family token a Claude model id sits in, positional: the family must come
// directly after the "claude-" prefix or BE the bare alias. A substring test
// reads any id containing the token as that family. Null when the id names no
// family — callers handle it rather than assume a string.
export function claudeFamilyOf(model) {
  const value = String(model || "").toLowerCase();
  const m = /^claude-(fable|opus|sonnet|haiku)(?:-|$)/.exec(value) || /^(fable|opus|sonnet|haiku)$/.exec(value);
  return m ? m[1] : null;
}

function record(name, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const spec = RECORD_FIELDS[name];
  for (const field of spec.required) {
    if (value[field] === undefined || value[field] === null) {
      throw new Error(`${name} requires field '${field}'`);
    }
  }
  const out = {};
  for (const field of [...spec.required, ...spec.optional]) {
    if (value[field] !== undefined) out[field] = value[field];
  }
  if ("provider" in out) out.provider = normalizeProvider(out.provider, name);
  if ("model" in out) out.model = normalizeModel(out.model, name);
  return out;
}

export function modelDescriptor(value) {
  const out = record("ModelDescriptor", value);
  if (!nonEmptyString(out.runner)) throw new Error("ModelDescriptor requires non-empty field 'runner'");
  out.runner = out.runner.trim().toLowerCase();
  if (out.displayName !== undefined) requireString(out.displayName, "ModelDescriptor field 'displayName'");
  if (out.efforts !== undefined) requireStringArray(out.efforts, "ModelDescriptor field 'efforts'");
  if (out.defaultEffort !== undefined) requireString(out.defaultEffort, "ModelDescriptor field 'defaultEffort'");
  if (out.modalities !== undefined) requireStringArray(out.modalities, "ModelDescriptor field 'modalities'");
  if (out.isDefault !== undefined) requireBoolean(out.isDefault, "ModelDescriptor field 'isDefault'");
  if (out.availability !== undefined) requirePlainObject(out.availability, "ModelDescriptor field 'availability'");
  return out;
}

export function providerUsageSnapshot(value) {
  const out = record("ProviderUsageSnapshot", value);
  if (!Array.isArray(out.buckets) || out.buckets.some((bucket) => !bucket || typeof bucket !== "object" || Array.isArray(bucket))) {
    throw new Error("ProviderUsageSnapshot field 'buckets' must be an array of objects");
  }
  requireString(out.source, "ProviderUsageSnapshot field 'source'");
  requireEnum(out.provenance, "ProviderUsageSnapshot field 'provenance'", PROVENANCE_STATES);
  requireTimestamp(out.asOf, "ProviderUsageSnapshot field 'asOf'");
  if (out.exhausted !== undefined) requireBoolean(out.exhausted, "ProviderUsageSnapshot field 'exhausted'");
  if (out.reason !== undefined) requireString(out.reason, "ProviderUsageSnapshot field 'reason'");
  return out;
}

export function runnerEvent(value) {
  const out = record("RunnerEvent", value);
  if (!nonEmptyString(out.type)) throw new Error("RunnerEvent requires non-empty field 'type'");
  if (out.sessionId !== undefined) requireString(out.sessionId, "RunnerEvent field 'sessionId'");
  if (out.text !== undefined) requireString(out.text, "RunnerEvent field 'text'", { allowEmpty: true });
  if (out.activity !== undefined) requirePlainObject(out.activity, "RunnerEvent field 'activity'");
  if (out.usage !== undefined) requirePlainObject(out.usage, "RunnerEvent field 'usage'");
  if (out.realModel !== undefined) requireString(out.realModel, "RunnerEvent field 'realModel'");
  if (out.terminal !== undefined) requireBoolean(out.terminal, "RunnerEvent field 'terminal'");
  if (out.error !== undefined) requireError(out.error, "RunnerEvent field 'error'");
  return out;
}

export function runResult(value) {
  const out = record("RunResult", value);
  if (typeof out.output !== "string") throw new Error("RunResult field 'output' must be a string");
  if (typeof out.terminal !== "boolean") throw new Error("RunResult field 'terminal' must be a boolean");
  if (out.sessionId !== undefined) requireString(out.sessionId, "RunResult field 'sessionId'");
  if (out.usage !== undefined) requirePlainObject(out.usage, "RunResult field 'usage'");
  if (out.realModel !== undefined) requireString(out.realModel, "RunResult field 'realModel'");
  if (out.error !== undefined) requireError(out.error, "RunResult field 'error'");
  return out;
}

export function costObservation(value) {
  const out = record("CostObservation", value);
  requireString(out.unit, "CostObservation field 'unit'");
  requireString(out.source, "CostObservation field 'source'");
  requireEnum(out.classification, "CostObservation field 'classification'", COST_CLASSIFICATIONS);
  requireTimestamp(out.asOf, "CostObservation field 'asOf'");
  if (out.value !== undefined && (typeof out.value !== "number" || !Number.isFinite(out.value) || out.value < 0)) {
    throw new Error("CostObservation field 'value' must be a non-negative finite number");
  }
  return out;
}

export function availabilityVerdict(value) {
  const out = record("AvailabilityVerdict", value);
  requireEnum(out.state, "AvailabilityVerdict field 'state'", AVAILABILITY_STATES);
  requireString(out.source, "AvailabilityVerdict field 'source'");
  requireTimestamp(out.asOf, "AvailabilityVerdict field 'asOf'");
  if (out.reason !== undefined) requireString(out.reason, "AvailabilityVerdict field 'reason'");
  return out;
}

// Legacy runs stored only model. Infer the provider on read when the model name
// is unambiguous; unknown model-only records stay intentionally unqualified.
// This keeps old corpora readable without rewriting history or guessing a route.
export function inferStoredIdentity(model) {
  if (typeof model !== "string" || !model.trim()) return {};
  const value = model.trim();
  if (/^(haiku|sonnet|opus|fable)$/i.test(value) || /^claude(?:-|$)/i.test(value)) {
    return { provider: "claude", runner: "claude" };
  }
  if (OLLAMA_CLOUD_RE.test(value)) return { provider: "ollama", runner: "claude" };
  return {};
}

// Turn evidence from a stored result: how many turns the attempt got down.
//
// FIELD FIRST. A failed attempt reports its own count now, so every runner
// answers the same way instead of one of them being read out of its prose. The
// scan of raw output survives only for results written before the field existed,
// and reproduces their verdict byte for byte.
//
// NULL is not zero. A count neither source can supply is UNKNOWN, and the caller
// must fall back — reading it as zero would make every pre-upgrade result on disk
// unresumable overnight.
export function storedTurnCount(result) {
  if (result?.numTurns != null) return result.numTurns;
  return /"num_turns"\s*:\s*0\b/.test(String(result?.output ?? "")) ? 0 : null;
}

// The one reading of a stored row's identity. Six modules held their own copy and
// they had already diverged on case and trimming, so the same row keyed two ways
// and a model's history split between them.
export function identityOf(value) {
  const raw = typeof value === "string" ? value : value?.model;
  const model = typeof raw === "string" ? raw.trim() : raw;
  const declared = typeof value?.provider === "string" ? value.provider.trim().toLowerCase() : "";
  const inferred = declared ? {} : inferStoredIdentity(model);
  return { provider: declared || inferred.provider || null, model, explicit: Boolean(declared) };
}

export function identityKey(value) {
  const identity = value && "explicit" in Object(value) ? value : identityOf(value);
  return JSON.stringify([identity.provider ?? null, identity.model]);
}

export function modelKey(provider, model) {
  return JSON.stringify([
    normalizeProvider(provider, "Model identity"),
    normalizeModel(model, "Model identity"),
  ]);
}

export function modelDisplay(provider, model) {
  return `${normalizeProvider(provider, "Model identity")}/${normalizeModel(model, "Model identity")}`;
}
