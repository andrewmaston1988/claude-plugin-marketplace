// The public surface of the split modules: importers never learn a module was split.
import { test } from "node:test";
import { deepEqual } from "node:assert/strict";

const SCHEDULER = ["classifyFailure", "launcherSession", "makeDefaultIo", "pickNewestRunning", "runPlan", "runTask", "substituteItems", "substituteTemplates"];
const RESULTS = [
  "appendRunLog", "displayIdentity", "formatClosing", "formatKeptWorktrees", "formatTokens", "gradeFooter",
  "heartbeatPath", "inferStoredIdentity", "initResultsDir", "listLeaves", "mechanicalOf", "normalizeStoredIdentity",
  "readHeartbeat", "readResult", "readSummary", "recordedSessionIds", "recordedSessionRecords", "renderProvenance",
  "renderRoster", "renderRun", "renderStatus", "resultPath", "stopPath", "touchHeartbeat", "transcriptPath",
  "truncationLines", "waiverPath", "writeDigestMd", "writeManifestSnapshot", "writeResult", "writeSummary",
];

test("scheduler.mjs exports exactly its pre-split names", async () => {
  deepEqual(Object.keys(await import("../src/scheduler.mjs")).sort(), SCHEDULER);
});

test("results.mjs exports exactly its pre-split names", async () => {
  deepEqual(Object.keys(await import("../src/results.mjs")).sort(), RESULTS);
});
