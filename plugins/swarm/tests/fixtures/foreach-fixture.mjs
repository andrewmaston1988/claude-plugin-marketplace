// A forEach whose clones are manifests (walk -> extend -> verify), glossary-shaped:
// clone 0 expanded and mid-chain, clone 1 expanded and starting, clone 2 still waiting
// on concurrency (no expand-manifest yet). Shared by the runlog and serve tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FOREACH_MANIFEST = {
  tasks: [
    { id: "enum", model: "sonnet", prompt: "list batches" },
    {
      id: "chain", model: "manifest", after: ["enum"],
      forEach: { from: "enum", path: "batches", maxItems: 10 },
      child: [
        { id: "walk", model: "sonnet", prompt: "walk {{item}}" },
        { id: "extend", model: "sonnet", after: ["walk"], prompt: "extend it" },
        { id: "verify", model: "haiku", after: ["extend"], prompt: "verify it" },
      ],
    },
    { id: "glossary", model: "sonnet", after: ["chain"], prompt: "write the glossary" },
  ],
  digest: { model: "sonnet", instructions: "…" },
};

export const FOREACH_LOG = [
  '{"ts":"2026-09-05T01:00:00Z","event":"run-start","tasks":[{"id":"enum","model":"sonnet"},{"id":"chain","model":"manifest"},{"id":"glossary","model":"sonnet"}]}',
  '{"ts":"2026-09-05T01:00:01Z","id":"enum","state":"running"}',
  '{"ts":"2026-09-05T01:01:00Z","id":"enum","state":"ok","durationMs":59000}',
  '{"ts":"2026-09-05T01:01:01Z","event":"expand","id":"chain","model":"manifest","clones":3}',
  '{"ts":"2026-09-05T01:01:02Z","event":"expand-manifest","id":"chain[0]","children":[{"id":"chain[0]~walk","model":"sonnet"},{"id":"chain[0]~extend","model":"sonnet"},{"id":"chain[0]~verify","model":"haiku"}]}',
  '{"ts":"2026-09-05T01:01:02Z","id":"chain[0]~walk","state":"running"}',
  '{"ts":"2026-09-05T01:02:00Z","id":"chain[0]~walk","state":"ok","durationMs":58000}',
  '{"ts":"2026-09-05T01:02:01Z","id":"chain[0]~extend","state":"running"}',
  '{"ts":"2026-09-05T01:02:02Z","event":"expand-manifest","id":"chain[1]","children":[{"id":"chain[1]~walk","model":"sonnet"},{"id":"chain[1]~extend","model":"sonnet"},{"id":"chain[1]~verify","model":"haiku"}]}',
  '{"ts":"2026-09-05T01:02:03Z","id":"chain[1]~walk","state":"running"}',
].join("\n");

export function buildForEachFixture(dir, { log = FOREACH_LOG } = {}) {
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "run.log"), log, "utf8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(FOREACH_MANIFEST), "utf8");
}
