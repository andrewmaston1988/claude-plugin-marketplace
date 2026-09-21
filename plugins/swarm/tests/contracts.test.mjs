import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import {
  availabilityVerdict,
  costObservation,
  modelDescriptor,
  modelDisplay,
  modelKey,
  providerUsageSnapshot,
  runResult,
  runnerEvent,
  identityOf,
  identityKey,
  PROVENANCE_STATES,
} from "../src/contracts.mjs";

function usageSnapshot(over = {}) {
  return providerUsageSnapshot({
    provider: "codex", buckets: [], source: "app-server", provenance: "live", asOf: "2026-09-18", ...over,
  });
}

test("identityOf reads a stored row's provider, or infers it from the model", () => {
  deepEqual(identityOf({ provider: "codex", model: "gpt-5" }), { provider: "codex", model: "gpt-5", explicit: true });
  // A legacy row recorded no provider; the model name still names one.
  equal(identityOf({ model: "glm-5.2:cloud" }).provider, "ollama");
  equal(identityOf({ model: "glm-5.2:cloud" }).explicit, false);
  equal(identityOf({ model: "sonnet" }).provider, "claude");
  // A bare string is a model with no provider recorded.
  equal(identityOf("sonnet").model, "sonnet");
  // Neither recorded nor inferable.
  equal(identityOf({ model: "mystery" }).provider, null);
  deepEqual(identityOf(undefined), { provider: null, model: undefined, explicit: false });
});

test("identityOf normalises surrounding space and provider case, so one model has one key", () => {
  // The six copies of this function disagreed: two lowercased the provider and three did
  // not, so the same row keyed two ways and a model's history split in half.
  equal(identityKey({ provider: "Codex", model: "gpt-5" }), identityKey({ provider: "codex", model: "gpt-5" }));
  equal(identityKey({ provider: " codex ", model: " gpt-5 " }), identityKey({ provider: "codex", model: "gpt-5" }));
  equal(identityKey({ provider: "codex", model: "gpt-5" }), '["codex","gpt-5"]');
  // Distinct providers still cannot collide.
  equal(identityKey({ provider: "ollama", model: "same" }) === identityKey({ provider: "codex", model: "same" }), false);
});

test("provider/model identity keys cannot collide", () => {
  equal(modelKey("ollama", "same"), '["ollama","same"]');
  equal(modelKey("codex", "same"), '["codex","same"]');
  equal(modelKey("ollama", "same") === modelKey("codex", "same"), false);
  equal(modelDisplay("codex", "gpt-5"), "codex/gpt-5");
});

test("six normalized records retain canonical fields and discard raw protocol payloads", () => {
  deepEqual(modelDescriptor({ provider: "codex", model: "gpt-5", runner: "codex", efforts: ["high"], raw: { secret: true } }), {
    provider: "codex", model: "gpt-5", runner: "codex", efforts: ["high"],
  });
  deepEqual(providerUsageSnapshot({ provider: "codex", buckets: [], source: "app-server", provenance: "live", asOf: "2026-09-18" }), {
    provider: "codex", buckets: [], source: "app-server", provenance: "live", asOf: "2026-09-18",
  });
  deepEqual(runnerEvent({ type: "completed", terminal: true, text: "done", raw: {} }), {
    type: "completed", text: "done", terminal: true,
  });
  deepEqual(runResult({ provider: "codex", model: "gpt-5", output: "done", terminal: true }), {
    provider: "codex", model: "gpt-5", output: "done", terminal: true,
  });
  deepEqual(costObservation({ provider: "codex", model: "gpt-5", unit: "usd", source: "prices", classification: "api-equivalent estimate", asOf: "2026-09-18" }), {
    provider: "codex", model: "gpt-5", unit: "usd", source: "prices", classification: "api-equivalent estimate", asOf: "2026-09-18",
  });
  deepEqual(availabilityVerdict({ provider: "codex", model: "gpt-5", state: "available", source: "model-list", asOf: "2026-09-18" }), {
    provider: "codex", model: "gpt-5", state: "available", source: "model-list", asOf: "2026-09-18",
  });
});

test("normalized records reject malformed scalar, enum, timestamp, and structured fields", () => {
  throws(() => modelDescriptor({ provider: "codex", model: "x", runner: "codex", isDefault: "yes" }), /isDefault.*boolean/);
  throws(() => modelDescriptor({ provider: "codex", model: "x", runner: "codex", efforts: ["high", 1] }), /efforts.*strings/);
  throws(() => providerUsageSnapshot({ provider: "codex", buckets: [1], source: "live", provenance: "rpc", asOf: "2026-09-18" }), /buckets.*objects/);
  throws(() => providerUsageSnapshot({ provider: "codex", buckets: [], source: {}, provenance: "rpc", asOf: "2026-09-18" }), /source.*string/);
  throws(() => runnerEvent({ type: "completed", terminal: "yes" }), /terminal.*boolean/);
  throws(() => runResult({ provider: "codex", model: "x", output: "", terminal: true, usage: [] }), /usage.*object/);
  throws(() => costObservation({ provider: "codex", model: "x", unit: "usd", source: "prices", classification: "guess", asOf: "2026-09-18" }), /classification.*one of/);
  throws(() => costObservation({ provider: "codex", model: "x", unit: "usd", source: "prices", classification: "billed", asOf: "not-a-date" }), /asOf.*timestamp/);
  throws(() => costObservation({ provider: "codex", model: "x", unit: "usd", source: "prices", classification: "billed", asOf: "0" }), /asOf.*timestamp/);
  throws(() => costObservation({ provider: "codex", model: "x", unit: "usd", source: "prices", classification: "billed", asOf: "09\/18\/2026" }), /asOf.*timestamp/);
  throws(() => costObservation({ provider: "codex", model: "x", unit: "usd", source: "prices", classification: "billed", asOf: "2026-02-30" }), /asOf.*timestamp/);
  throws(() => costObservation({ provider: "codex", model: "x", unit: "usd", source: "prices", classification: "billed", asOf: "2026-02-30T00:00:00Z" }), /asOf.*timestamp/);
  throws(() => availabilityVerdict({ provider: "codex", model: "x", state: "maybe", source: "models", asOf: "2026-09-18" }), /state.*one of/);
});

test("normalized records name missing required fields", () => {
  throws(() => modelDescriptor({ model: "x", runner: "codex" }), /ModelDescriptor.*provider/);
  throws(() => providerUsageSnapshot({ provider: "codex", buckets: [] }), /ProviderUsageSnapshot.*source/);
  throws(() => runnerEvent({}), /RunnerEvent.*type/);
  throws(() => runResult({ provider: "codex", model: "x", output: "" }), /RunResult.*terminal/);
  throws(() => costObservation({ provider: "codex", model: "x" }), /CostObservation.*unit/);
  throws(() => availabilityVerdict({ provider: "codex", model: "x" }), /AvailabilityVerdict.*state/);
});

// Defect CS-9 — `provenance` crossed the trust boundary as a plain string while
// its siblings (`classification`, `state`) checked against a declared set. Both
// directions of the display key off this token — `provenanceBanner` suppresses
// itself for `live`, the headroom gate trusts only `live` — so a typo'd `"Live"`
// renders as an unverified reading with no caveat and no error.
// The token list is read off the shipped sources, not memory: live
// (codex-usage), cached/none (ollama-usage), cache (usage.mjs's Anthropic TTL
// cache read), unknown (normalizeProviderUsage's generic path), partial (a
// half-failed codex read).
test("providerUsageSnapshot: every shipped provenance token is accepted, a typo is not", () => {
  const SHIPPED = ["live", "cached", "cache", "none", "unknown", "partial"];
  deepEqual([...PROVENANCE_STATES].sort(), [...SHIPPED].sort());
  for (const provenance of SHIPPED) equal(usageSnapshot({ provenance }).provenance, provenance);
  throws(() => usageSnapshot({ provenance: "Live" }), /provenance.*one of/);
  throws(() => usageSnapshot({ provenance: "lively" }), /provenance.*one of/);
  throws(() => usageSnapshot({ provenance: "" }), /provenance/);
});

// `record()` keeps only the fields in a record's required+optional list, so an
// un-widened ProviderUsageSnapshot drops `exhausted` and `reason` in silence —
// the scheduler gate reads `undefined`, dispatches into an exhausted allowance,
// and every source row stays green. This is the row that guards that trap.
test("providerUsageSnapshot: optional exhausted and reason survive record()", () => {
  const out = usageSnapshot({ exhausted: true, reason: "account/usage/read failed" });
  equal(out.exhausted, true);
  equal(out.reason, "account/usage/read failed");
  // Absent means absent: a reading nobody measured must not carry a false that
  // reads as "has headroom".
  equal("exhausted" in usageSnapshot({}), false);
  throws(() => usageSnapshot({ exhausted: "yes" }), /exhausted.*boolean/);
  throws(() => usageSnapshot({ reason: 42 }), /reason.*string/);
});

