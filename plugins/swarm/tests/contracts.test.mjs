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
} from "../src/contracts.mjs";

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
