import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { locateAgent } from "../scripts/locate-agent.mjs";

test("locateAgent — standard subagent", () => {
  const testDir = join(tmpdir(), `locate-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  try {
    const agentId = "a3a4e064401835fe3";
    const filePath = join(testDir, `agent-${agentId}.jsonl`);
    writeFileSync(filePath, "");

    const result = locateAgent(testDir, agentId);
    assert.equal(result, filePath, "should locate standard agent file");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("locateAgent — workflow subagent", () => {
  const testDir = join(tmpdir(), `locate-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "subagents", "workflows", "wf_7770f48d"), {
    recursive: true,
  });

  try {
    const agentId = "a3a4e064401835fe3";
    const filePath = join(
      testDir,
      "subagents",
      "workflows",
      "wf_7770f48d",
      `agent-${agentId}.jsonl`
    );
    writeFileSync(filePath, "");

    const result = locateAgent(testDir, agentId);
    assert.equal(result, filePath, "should locate workflow agent file");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("locateAgent — unknown ID returns null", () => {
  const testDir = join(tmpdir(), `locate-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  try {
    const result = locateAgent(testDir, "unknown-agent-id");
    assert.equal(result, null, "should return null for unknown agent");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("locateAgent — prefix match (short ID)", () => {
  const testDir = join(tmpdir(), `locate-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  try {
    const agentId = "a3a4e";
    const fullId = "a3a4e064401835fe3";
    const filePath = join(testDir, `agent-${fullId}.jsonl`);
    writeFileSync(filePath, "");

    const result = locateAgent(testDir, agentId);
    assert.equal(result, filePath, "should match partial agent ID");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("locateAgent — empty ID returns null", () => {
  const testDir = join(tmpdir(), `locate-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  try {
    const result = locateAgent(testDir, "");
    assert.equal(result, null, "should return null for empty agent ID");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
