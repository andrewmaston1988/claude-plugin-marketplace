// A run.log that exercises every event the parser handles: run-start roster, state
// changes with durations and tokens, live token ticks, activity, a forEach expand,
// a child-manifest splice, a quiet running leaf, and a torn tail line. Shared by
// the goldens and the runlog tests so they pin the same bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUN_LOG = [
  '{"ts":"2026-09-05T01:00:00Z","event":"run-start","tasks":[{"id":"find-a","model":"glm-5.3:cloud"},{"id":"find-b","model":"glm-5.3:cloud"},{"id":"fix","model":"sonnet"},{"id":"review","model":"haiku"},{"id":"__digest","model":"sonnet"}]}',
  '{"ts":"2026-09-05T01:00:01Z","id":"find-a","state":"running"}',
  '{"ts":"2026-09-05T01:00:01Z","id":"find-b","state":"running"}',
  '{"ts":"2026-09-05T01:00:20Z","id":"find-a","event":"activity","activity":"Grep registerRoute"}',
  '{"ts":"2026-09-05T01:00:30Z","id":"find-a","event":"tokens","tokens":{"input":40000,"output":900,"cacheCreation":0,"cacheRead":0}}',
  '{"ts":"2026-09-05T01:02:00Z","id":"find-a","state":"ok","durationMs":119000,"tokens":{"input":81000,"output":2100,"cacheCreation":0,"cacheRead":0}}',
  '{"ts":"2026-09-05T01:02:10Z","event":"expand","id":"fix","model":"sonnet","clones":2}',
  '{"ts":"2026-09-05T01:02:11Z","id":"fix[0]","state":"running"}',
  '{"ts":"2026-09-05T01:02:11Z","id":"fix[1]","state":"running"}',
  '{"ts":"2026-09-05T01:03:00Z","id":"fix[0]","event":"activity","activity":"Edit src/a.mjs"}',
  '{"ts":"2026-09-05T01:03:05Z","id":"fix[0]","event":"tokens","tokens":{"input":12000,"output":3000,"cacheCreation":2000,"cacheRead":50000}}',
  '{"ts":"2026-09-05T01:04:00Z","id":"fix[1]","state":"rate-limited"}',
  '{"ts":"2026-09-05T01:05:00Z","event":"expand-manifest","id":"review","children":[{"id":"review~lint","model":"haiku"},{"id":"review~test","model":"haiku"}]}',
  '{"ts":"2026-09-05T01:05:01Z","id":"review~lint","state":"running"}',
  '{"ts":"2026-09-05T01:05:30Z","id":"review~lint","state":"failed","durationMs":29000,"note":"exit 1"}',
  '{"ts":"2026-09-05T01:06:00Z","id":"find-b","event":"activity","activity":"Read src/b.mjs"}',
  '{"ts":"2026-09-05T01:08:00Z","id":"find-b","event":"tokens","tokens":{"input":220000,"output":4000,"cacheCreation":0,"cacheRead":0}}',
  '{"ts":"2026-09-05T01:09:5', // torn tail write mid-run — must be skipped
].join("\n");

export const NOW = Date.parse("2026-09-05T01:10:00Z");

export function buildFixture(dir) {
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "run.log"), RUN_LOG, "utf8");
  writeFileSync(join(dir, "digest.md"), "# digest\n", "utf8");
}
