// Asserts that the governor-session.md template only references $VAR names
// that governor.mjs's spawn env actually sets (the "spawn contract").
import { test } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CONTRACT_VARS, ALWAYS_PRESENT, findUnknownTemplateVars } from "../src/governor/env-contract.mjs";

const TEMPLATE_PATH = fileURLToPath(
  new URL("../templates/governor-session.md", import.meta.url)
);

test("governor-session.md template exists", () => {
  ok(existsSync(TEMPLATE_PATH), `template not found at ${TEMPLATE_PATH}`);
});

test("governor-session.md: all $VAR references are in the spawn contract", () => {
  const content = readFileSync(TEMPLATE_PATH, "utf8");
  const unknown = findUnknownTemplateVars(content);
  strictEqual(
    unknown.length, 0,
    `template references vars not in spawn contract: ${unknown.join(", ")}`
  );
});

test("bundled template returns no unknown vars (regression)", () => {
  const content = readFileSync(TEMPLATE_PATH, "utf8");
  const unknown = findUnknownTemplateVars(content);
  strictEqual(
    unknown.length, 0,
    `bundled template should reference only contract vars; found: ${unknown.join(", ")}`
  );
});

test("governor.mjs sets all spawn-contract vars", () => {
  const govPath = fileURLToPath(
    new URL("../src/orchestrator/governor.mjs", import.meta.url)
  );
  const src = readFileSync(govPath, "utf8");
  for (const varName of CONTRACT_VARS) {
    ok(
      src.includes(`env.${varName}`),
      `governor.mjs does not set env.${varName}`
    );
  }
});
