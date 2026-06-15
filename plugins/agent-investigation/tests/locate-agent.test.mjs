import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { locateAgent, locateAgentInProject } from "../scripts/locate-agent.mjs";
import { getProjectSlug } from "../src/paths.mjs";

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
  mkdirSync(join(testDir, "workflows", "wf_7770f48d"), {
    recursive: true,
  });

  try {
    const agentId = "a3a4e064401835fe3";
    const filePath = join(
      testDir,
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

// Exercises the production discovery path: cwd → slug → projects/<slug>/<session>/subagents/
test("locateAgentInProject — resolves via mocked projects dir", () => {
  const projectsDir = join(tmpdir(), `projects-test-${Date.now()}`);
  const cwd = "C:\\code\\my-project";
  const slug = getProjectSlug(cwd);
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const agentId = "a3a4e064401835fe3";

  const subagentsDir = join(projectsDir, slug, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const standardFile = join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(standardFile, "");

  // A workflow agent in a second session
  const wfId = "abcdef01234567890";
  const wfDir = join(projectsDir, slug, "66666666-7777-8888-9999-000000000000", "subagents", "workflows", "wf_1234");
  mkdirSync(wfDir, { recursive: true });
  const wfFile = join(wfDir, `agent-${wfId}.jsonl`);
  writeFileSync(wfFile, "");

  try {
    assert.equal(
      locateAgentInProject(agentId, cwd, projectsDir),
      standardFile,
      "should find standard subagent across sessions"
    );
    assert.equal(
      locateAgentInProject(wfId, cwd, projectsDir),
      wfFile,
      "should find workflow subagent across sessions"
    );
    assert.equal(
      locateAgentInProject("nonexistent", cwd, projectsDir),
      null,
      "should return null when no session holds the agent"
    );
  } finally {
    rmSync(projectsDir, { recursive: true, force: true });
  }
});

test("locateAgentInProject — missing project dir returns null", () => {
  const projectsDir = join(tmpdir(), `projects-missing-${Date.now()}`);
  assert.equal(
    locateAgentInProject("anything", "C:\\code\\nope", projectsDir),
    null,
    "should return null when the project dir does not exist"
  );
});
