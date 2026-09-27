import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFixture } from "../fixtures/run-fixture.mjs";

// The manifest snapshot the engine writes at dispatch (effectivePlanDoc shape):
// two finders → a forEach fixer → a child manifest → digest block.
const MANIFEST = {
  resultsDir: "<dir>",
  tasks: [
    { id: "find-a", model: "glm-5.3:cloud", prompt: "…" },
    { id: "find-b", model: "glm-5.3:cloud", prompt: "…" },
    { id: "fix", model: "sonnet", after: ["find-a", "find-b"], forEach: { from: "find-a", path: "sites", maxItems: 30 }, prompt: "…" },
    { id: "review", model: "haiku", after: ["fix"], child: [
      { id: "lint", model: "haiku", prompt: "…" },
      { id: "test", model: "haiku", after: ["lint"], prompt: "…" },
    ] },
    { id: "join", after: ["fix"], compute: "length(deps['fix'])" },
  ],
  digest: { model: "sonnet", instructions: "…" },
};

export function withFixture(fn, { manifest = MANIFEST } = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarm-runlog-"));
  const dir = join(home, "runs", "C--code-proj", "fixture-1");
  try {
    buildFixture(dir);
    if (manifest) writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
    return fn({ home, dir });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
