import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok } from "node:assert/strict";
import { ValidationError } from "../../src/manifest.mjs";

// Fixtures shared by every manifest-loading test file. They live here rather than in
// manifest.test.mjs because importing a .test.mjs from another .test.mjs re-registers and
// re-runs its rows in the importing file's process — the suite count doubles.

export const CFG = {
  // allowedRoots gates every provider including Claude, and an empty list denies. Every
  // test dir is a tmpdir child, so one root permits them all without weakening the gate.
  provider: { allowedRoots: [] },
  providers: { claude: { enabled: true, allowedRoots: [tmpdir()] } },
  concurrency: 4,
  timeoutMs: 600000,
  resultInlineCap: 4000,
};

export function writeManifest(dir, body, name = "plan.json") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

export function tmp() {
  return mkdtempSync(join(tmpdir(), "swarm-man-"));
}

export function errorsOf(fn) {
  try {
    fn();
  } catch (e) {
    ok(e instanceof ValidationError, `expected ValidationError, got ${e}`);
    return e.errors;
  }
  throw new Error("expected loadManifest to throw");
}

export const claudeTask = (over = {}) => ({ id: "a", prompt: "do it", provider: "claude", model: "claude-haiku-4-5-20251001", ...over });

// A tree follows from write tools, so every test that wants one asks for them.
export const writerTask = (over = {}) => claudeTask({ allowedTools: "Read,Edit,Bash", ...over });
