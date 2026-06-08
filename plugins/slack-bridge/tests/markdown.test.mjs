import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mdToSlack, mdToBlocks, hasTable } from "../src/markdown/index.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dir, "fixtures/markdown");

const fixtures = readdirSync(fixturesDir)
  .filter(f => f.endsWith(".md.txt"))
  .map(f => f.replace(".md.txt", ""))
  .sort();

for (const name of fixtures) {
  const inputPath = join(fixturesDir, `${name}.md.txt`);
  const mrkdwnPath = join(fixturesDir, `${name}.expected.mrkdwn.txt`);
  const blocksPath = join(fixturesDir, `${name}.expected.blocks.json`);

  const input = readFileSync(inputPath, "utf8");
  const expectedMrkdwn = readFileSync(mrkdwnPath, "utf8");
  const expectedBlocks = JSON.parse(readFileSync(blocksPath, "utf8"));

  test(`markdown ${name} — mdToSlack`, () => {
    const result = mdToSlack(input);
    assert.strictEqual(result, expectedMrkdwn, `mdToSlack mismatch for ${name}`);
  });

  test(`markdown ${name} — mdToBlocks`, () => {
    const result = mdToBlocks(input);
    assert.deepStrictEqual(result, expectedBlocks, `mdToBlocks mismatch for ${name}`);
  });

  test(`markdown ${name} — hasTable`, () => {
    const result = hasTable(input);
    assert.strictEqual(result, expectedBlocks !== null, `hasTable mismatch for ${name}`);
  });
}
