// Backfill: copy coordinator_goals rows from claude.db into pipeline.db.
// Idempotent: uses INSERT OR REPLACE keyed on cwd.
//
// Usage:
//   node backfill-coordinator-goals.mjs [/path/to/claude.db]
//
// Default claude.db path: ~/.claude/claude.db
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { connectUnified } from "./connection.mjs";
import { backfillCoordinatorGoalsFromClaudeDb } from "./coordinator-goals.mjs";

function expandUserPath(path) {
  if (!path || typeof path !== "string") return path;
  if (path.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE;
    return path.replace(/^~/, home || "");
  }
  return path;
}

const explicit = process.argv[2];
const claudeDbPath = expandUserPath(explicit || "~/.claude/claude.db");

if (!existsSync(claudeDbPath)) {
  console.error(`Error: claude.db not found at ${claudeDbPath}`);
  process.exit(1);
}

const pipelineDb = connectUnified();
try {
  const beforeCount = pipelineDb.prepare("SELECT COUNT(*) AS c FROM coordinator_goals").get().c;
  backfillCoordinatorGoalsFromClaudeDb(pipelineDb, claudeDbPath);
  const afterCount = pipelineDb.prepare("SELECT COUNT(*) AS c FROM coordinator_goals").get().c;
  const added = afterCount - beforeCount;
  console.log(`Backfill completed. rows before=${beforeCount} after=${afterCount} (added/replaced=${added}).`);
} finally {
  pipelineDb.close();
}
