import { test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { modelFromNotes, proxyEnvFor } from "../scripts/orchestrator/spawn.mjs";

test("modelFromNotes: regex accepts colon (gemma4:31b-cloud)", () => {
  const m = modelFromNotes("model=gemma4:31b-cloud", "p", "f", "dev", null);
  strictEqual(m, "gemma4:31b-cloud");
});

test("modelFromNotes: falls back to row.d_model when notes lack a pin", () => {
  const m = modelFromNotes("", "p", "f", "dev", null, { d_model: "gemma4:31b-cloud", rvw_model: "claude-sonnet-4-6" });
  strictEqual(m, "gemma4:31b-cloud");
});

test("modelFromNotes: review stype falls back to row.rvw_model", () => {
  const m = modelFromNotes("", "p", "f", "review", null, { d_model: "claude-haiku-4-5", rvw_model: "claude-sonnet-4-6" });
  strictEqual(m, "claude-sonnet-4-6");
});

test("modelFromNotes: '—' sentinel in row column is ignored", () => {
  const m = modelFromNotes("", "p", "f", "dev", null, { d_model: "—" });
  // Falls through to config default; assert it's at least not the sentinel.
  strictEqual(m === "—", false);
});

test("proxyEnvFor: claude- models return empty (no proxy)", () => {
  deepStrictEqual(proxyEnvFor("claude-haiku-4-5-20251001"), {});
  deepStrictEqual(proxyEnvFor("claude-sonnet-4-6"), {});
});

test("proxyEnvFor: non-claude models return proxy env vars", () => {
  deepStrictEqual(proxyEnvFor("gemma4:31b-cloud"), {
    ANTHROPIC_BASE_URL: "http://localhost:18081",
    ANTHROPIC_API_KEY:  "dummy-local-key",
    ANTHROPIC_MODEL:    "gemma4:31b-cloud",
  });
});

test("proxyEnvFor: empty/falsy model returns empty", () => {
  deepStrictEqual(proxyEnvFor(""), {});
  deepStrictEqual(proxyEnvFor(null), {});
  deepStrictEqual(proxyEnvFor(undefined), {});
});
