import { test } from "node:test";
import { strictEqual, deepStrictEqual, equal } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelFromNotes, proxyEnvFor } from "../scripts/orchestrator/spawn.mjs";
import { loadPipelineConfig } from "../src/pipeline-config.mjs";

test("modelFromNotes: regex accepts colon (Ollama-style tag)", () => {
  const m = modelFromNotes("model=gemma4:31b-cloud", "p", "f", "dev", null);
  strictEqual(m, "gemma4:31b-cloud");
  const m2 = modelFromNotes("model=MiniMax-M3", "p", "f", "dev", null);
  strictEqual(m2, "MiniMax-M3");
});

test("modelFromNotes: falls back to row.d_model when notes lack a pin", () => {
  const m = modelFromNotes("", "p", "f", "dev", null, { d_model: "MiniMax-M3", rvw_model: "claude-sonnet-4-6" });
  strictEqual(m, "MiniMax-M3");
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

test("proxyEnvFor: claude-* models return empty (no proxy, additive contract)", () => {
  // Pin: any model whose name starts with `claude-` must NOT receive proxy env
  // overrides. This is the additive contract — Anthropic models still hit
  // api.anthropic.com directly. If a future change weakens this early-return,
  // these assertions fail and the regression is caught here, not in production.
  deepStrictEqual(proxyEnvFor("claude-haiku-4-5"), {});
  deepStrictEqual(proxyEnvFor("claude-sonnet-4-6"), {});
  deepStrictEqual(proxyEnvFor("claude-opus-4-8"), {});
  deepStrictEqual(proxyEnvFor("claude-fable-5"), {});
});

test("proxyEnvFor: non-claude models return proxy env vars with default URL", () => {
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

// ── New tests added with the rename ─────────────────────────────────────────

test("proxyEnvFor: MiniMax-M3 routes through proxy with default URL", () => {
  // Mirrors the gemma case — proves the proxy is model-agnostic. The proxy's
  // server.py model-validation (only remaps haiku/sonnet/opus/fable/claude-*)
  // passes other names through verbatim to OPENAI_BASE_URL.
  deepStrictEqual(proxyEnvFor("MiniMax-M3"), {
    ANTHROPIC_BASE_URL: "http://localhost:18081",
    ANTHROPIC_API_KEY:  "dummy-local-key",
    ANTHROPIC_MODEL:    "MiniMax-M3",
  });
});

test("proxyEnvFor: gemma and MiniMax return structurally identical env blocks (model-agnostic)", () => {
  const a = proxyEnvFor("gemma4:31b-cloud");
  const b = proxyEnvFor("MiniMax-M3");
  deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
  // Only ANTHROPIC_MODEL differs by design (the model name is forwarded).
  equal(a.ANTHROPIC_BASE_URL, b.ANTHROPIC_BASE_URL);
  equal(a.ANTHROPIC_API_KEY,  b.ANTHROPIC_API_KEY);
  equal(a.ANTHROPIC_MODEL,    "gemma4:31b-cloud");
  equal(b.ANTHROPIC_MODEL,    "MiniMax-M3");
});

test("proxyEnvFor: cfg.proxy.url override from config file propagates", () => {
  // Operator runs the proxy on a different port (or a different host entirely).
  // The override must propagate to the spawned env block.
  const dir = mkdtempSync(join(tmpdir(), "ollama-proxy-url-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ proxy: { url: "http://192.168.1.50:19000", auth_token: "operator-set-token" } }));
  try {
    const cfg = loadPipelineConfig(file);
    // Sanity: the loader picked up the override.
    equal(cfg.proxy.url, "http://192.168.1.50:19000");
    equal(cfg.proxy.auth_token, "operator-set-token");
    // The override is observable in the env block — pass the loaded cfg in
    // explicitly so the test doesn't depend on the operator's live ~/.pipeline.
    const env = proxyEnvFor("MiniMax-M3", cfg);
    equal(env.ANTHROPIC_BASE_URL, "http://192.168.1.50:19000");
    equal(env.ANTHROPIC_API_KEY,  "operator-set-token");
    equal(env.ANTHROPIC_MODEL,    "MiniMax-M3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxyEnvFor: partial cfg.proxy override preserves untouched fields via deep merge", () => {
  // Operator overrides only url; auth_token falls back to the default.
  const dir = mkdtempSync(join(tmpdir(), "ollama-proxy-partial-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ proxy: { url: "http://localhost:9999" } }));
  try {
    const cfg = loadPipelineConfig(file);
    const env = proxyEnvFor("MiniMax-M3", cfg);
    equal(env.ANTHROPIC_BASE_URL, "http://localhost:9999");
    equal(env.ANTHROPIC_API_KEY,  "dummy-local-key"); // default preserved
    equal(env.ANTHROPIC_MODEL,    "MiniMax-M3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
