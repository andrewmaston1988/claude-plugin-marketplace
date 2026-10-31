// Step 6 (Docs) of the API-credit lane: README and setup.md carry the billed-leaf
// carve-out, the `billing` opt-in, `apiKeyEnv`, and the limitations the plan names.
// The blanket "never manages credentials" claim must be gone from README.
import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const swarm = join(fileURLToPath(import.meta.url), "..", "..");
const read = (rel) => readFileSync(join(swarm, rel), "utf8");

const readme = read("README.md");
const setup = read("skills/swarm/references/setup.md");

test("README documents the billed-leaf API-credit carve-out", () => {
  ok(readme.includes('"billing": "api"'), "README must show the per-leaf opt-in");
  ok(readme.includes("apiKeyEnv"), "README must name the apiKeyEnv key");
  ok(readme.includes("SWARM_ANTHROPIC_API_KEY"), "README must name the default key variable");
  ok(
    !readme.includes("never manages credentials; auth is your provider app's ambient sign-in"),
    "the blanket no-credentials claim must be replaced by the carve-out",
  );
  ok(readme.includes("claude-api/"), "README must name the billed-leaf label");
  ok(readme.includes("apiKeySource"), "README must state each result records the credential used");
  ok(readme.includes("credit balance is too low"), "README must name the credit-exhaustion quota text");
});

test("setup.md documents billing and apiKeyEnv", () => {
  ok(setup.includes('"billing": "api"'), "setup must show the per-leaf opt-in");
  ok(setup.includes("| `providers.claude.apiKeyEnv`"), "setup's appendix must carry the apiKeyEnv row");
  ok(setup.includes("SWARM_ANTHROPIC_API_KEY"), "setup must name the default key variable");
  ok(setup.includes("apiKeySource"), "setup must state each result records the credential used");
});
