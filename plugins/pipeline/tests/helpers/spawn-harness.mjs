import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPath, close, projectAdd } from "../../src/db/index.mjs";

export const PROJECT = "testproject";

// Hermetic stub: spawnSession's escalation/spawn-blocked paths publish real
// notification envelopes (forwarded to Slack by the live orchestrator) unless
// the sink is injected. Tests must never touch the real notifier.
export const noopNotify = async () => true;

export function createMockLog() {
  const logs = [];
  const fn = (msg, level = "INFO") => { logs.push({ msg, level }); };
  fn.getLogs = () => logs;
  fn.hasMessage = (substr) => logs.some(l => l.msg.includes(substr));
  return fn;
}

export function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "spawn-escalation-"));
  const dbPath = join(tmp, "pipeline.db");
  const projectRoot = join(tmp, "project");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  const db = connectPath(dbPath);
  projectAdd(db, { name: PROJECT, rootPath: projectRoot });
  return { tmp, db, projectRoot };
}

export function teardown(tmp, db) {
  try { close(db); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
