import { resolve, expandUser } from "node:path";
import { existsSync } from "node:fs";
import { connectUnified } from "./connection.mjs";

function expandUserPath(path) {
  if (!path || typeof path !== "string") return path;
  if (path.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE;
    return path.replace(/^~/, home || "");
  }
  return path;
}

const pipelineDb = connectUnified();
const claudeDbPath = expandUserPath("~/.claude/claude.db");

if (!existsSync(claudeDbPath)) {
  console.error(`Error: claude.db not found at ${claudeDbPath}`);
  process.exit(1);
}

try {
  pipelineDb.exec(`ATTACH DATABASE '${claudeDbPath}' AS claude_attached`);

  pipelineDb.exec("BEGIN");
  try {
    pipelineDb.exec(`
      INSERT OR REPLACE INTO claude_sessions
        (session_id, cwd, started_at, user_ts, summary, last_checkpoint_size)
      SELECT
        session_id,
        cwd,
        CAST(ts AS REAL) AS started_at,
        CAST(user_ts AS REAL) AS user_ts,
        NULL AS summary,
        last_checkpoint_size
      FROM claude_attached.claude_sessions
    `);
    pipelineDb.exec("COMMIT");
    console.log("Backfill completed successfully.");
  } catch (err) {
    pipelineDb.exec("ROLLBACK");
    throw err;
  }
} finally {
  pipelineDb.exec("DETACH DATABASE claude_attached");
  pipelineDb.close();
}
