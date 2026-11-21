// The marketplace's own CI wiring: the config's suites against
// `.github/workflows/test.yml`. The runner's mechanics live in the package; this
// file only asserts that this repository still wires each suite the same way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateConfig } from "@andrewmaston1988/test-runner";

import config from "../test-runner.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, "..", ".github", "workflows", "test.yml");

const yml = readFileSync(WORKFLOW, "utf8");

/** The workflow split into one block per job name. */
function jobBlocks() {
  return yml
    .split(/^  [a-z-]+:$/m)
    .filter((block) => block.includes("runs-on:"));
}

test("no two runs of a suite share a label, so neither log overwrites the other", () => {
  for (const suite of config.suites) {
    const labels = suite.runs.map((run) => `${suite.name}${run.label ? `[${run.label}]` : ""}`);
    assert.equal(new Set(labels).size, labels.length, `${suite.name}: ${labels.join(", ")}`);
  }
});

test("every config suite is run by CI through the runner", () => {
  for (const suite of config.suites) {
    assert.match(
      yml,
      new RegExp(`node scripts/test\\.mjs --suite ${suite.name}\\b`),
      `no CI step runs --suite ${suite.name}`,
    );
  }
});

test("every --suite CI names is a config suite", () => {
  // Comments talk about the runner too; only a real invocation counts.
  const body = yml.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const named = new Set([...body.matchAll(/--suite\s+([a-z][a-z0-9-]*)/g)].map((match) => match[1]));
  assert.ok(named.size > 0, "test.yml carries no --suite call at all");
  for (const name of named) {
    assert.ok(
      config.suites.some((suite) => suite.name === name),
      `CI names --suite ${name}, which the config does not have`,
    );
  }
});

test("every CI suite job selects itself from the diff and has its base history", () => {
  const blocks = jobBlocks().filter((block) => /run: node scripts\/test\.mjs --suite/.test(block));
  assert.equal(blocks.length, config.suites.length, "a suite job is missing from the workflow");
  for (const block of blocks) {
    assert.match(block, /--if-selected --against/, "a suite job runs whatever the diff touches");
    assert.match(block, /fetch-depth: 0/, "a suite job cannot see its diff base in a shallow clone");
  }
  assert.match(yml, /run: node scripts\/test\.mjs --orphans/, "the always-running job checks no orphans");
});

test("every job installs the root dependencies before the shim runs", () => {
  const jobs = jobBlocks();
  assert.ok(jobs.length > 0, "test.yml carries no job at all");
  for (const job of jobs) {
    const name = /^\s+name: (.+)$/m.exec(job)?.[1] ?? "(anonymous job)";
    const install = job.indexOf("run: npm ci");
    const firstShim = job.indexOf("node scripts/");
    assert.ok(install !== -1, `${name}: no "run: npm ci" step, so a local run has nothing installed`);
    assert.ok(firstShim !== -1, `${name}: no "node scripts/" step`);
    // The step installs; the shim skips its own install gate under CI.
    assert.ok(install < firstShim, `${name}: its npm ci step runs after the first "node scripts/" step`);
  }
});

test("every CI-only step the runner does not own is still there by name", () => {
  const kept = [
    "500-line bar",
    "Plant read-only home sentinels",
    "Verify home sentinels untouched",
    "Plant read-only pipeline home sentinels",
    "Verify pipeline home sentinels untouched",
    "Check plugin file types",
  ];
  for (const name of kept) assert.match(yml, new RegExp(`name:\\s*${name}`), `CI lost "${name}"`);
});

test("pipeline's npm ci step is gone, because its suite's install runs it", () => {
  assert.doesNotMatch(yml, /name:\s*Install dependencies/);
  const pipeline = config.suites.find((suite) => suite.name === "pipeline");
  assert.ok(pipeline, "the config has no pipeline suite");
  for (const run of pipeline.runs) {
    assert.deepEqual(run.install, ["npm", "ci"], "the install moved into the config");
  }
});

test("the config passes the package's own validation", () => {
  assert.doesNotThrow(() => validateConfig(config));
});
