#!/usr/bin/env node
// Fake `claude` binary for the live-verification harness. Mimics enough of
// a real session that the orchestrator's spawn → progress → reap loop can
// be exercised end-to-end without a real Claude install.
//
// Behaviour:
//   - Parses CORRELATION_ID from env + the session-file path from -p prompt
//   - Simulates 4 progress steps over 1s (1 in_progress → 4 completed)
//   - Writes a session JSONL log under ~/.claude/projects/<encoded>/
//   - Exits 0 when steps complete (or the env-override controls failure)
//
// Override knobs (set in harness):
//   FAKE_CLAUDE_STEPS         — total step count (default 4)
//   FAKE_CLAUDE_DURATION_MS   — total wall-clock for the simulated session
//   FAKE_CLAUDE_FAIL          — set to "1" to exit non-zero before completing
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// Allow the harness to inject its plugin paths via env
const PLUGIN_ROOT = process.env.FAKE_CLAUDE_PLUGIN_ROOT
  || join(HERE, "..", "..");

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}
const prompt   = flag("-p") || "";
const stepCount = parseInt(process.env.FAKE_CLAUDE_STEPS || "4", 10);
const totalMs   = parseInt(process.env.FAKE_CLAUDE_DURATION_MS || "1000", 10);
const wantFail  = process.env.FAKE_CLAUDE_FAIL === "1";
const cid       = process.env.CORRELATION_ID || "fake-cid";
const sessionFileMatch = /Read '([^']+)'/.exec(prompt);
const sessionFile = sessionFileMatch ? sessionFileMatch[1] : "";
const slugMatch   = /([^/\\]+)\.md$/.exec(sessionFile);
const slug        = slugMatch ? slugMatch[1] : cid;

// JSONL session log under ~/.claude/projects/<encoded-cwd>/<sessid>.jsonl
const cwd  = process.cwd();
const enc  = cwd.replace(/[:\\/]/g, "-");
const jsonlDir  = join(homedir(), ".claude", "projects", enc);
const jsonlPath = join(jsonlDir, `${cid}.jsonl`);
mkdirSync(jsonlDir, { recursive: true });

function jsonlLine(obj) {
  appendFileSync(jsonlPath, JSON.stringify(obj) + "\n");
}
function assistantTool(name, input) {
  jsonlLine({ type: "assistant_message", message: {
    role: "assistant",
    content: [{ type: "tool_use", name, input }],
  }});
}
function assistantText(text) {
  jsonlLine({ type: "assistant_message", message: {
    role: "assistant",
    content: [{ type: "text", text }],
  }});
}

(async () => {
  // Write progress_files + progress_steps directly via the same DB helpers
  // the real orchestrator uses. The harness pre-seeds paths via PIPELINE_DATA_DIR.
  const { connectUnified, close } = await import(
    `file://${join(PLUGIN_ROOT, "scripts", "pipeline-db", "index.mjs").replace(/\\/g, "/")}`
  );
  const { getPaths } = await import(
    `file://${join(PLUGIN_ROOT, "src", "paths.mjs").replace(/\\/g, "/")}`
  );

  const db = connectUnified(getPaths());
  const pfStmt = db.prepare("INSERT OR REPLACE INTO progress_files (slug, project, session_type, is_active) VALUES (?, ?, ?, 1)");
  const psDel  = db.prepare("DELETE FROM progress_steps WHERE slug = ?");
  const psStmt = db.prepare("INSERT INTO progress_steps (slug, step_index, content, state) VALUES (?, ?, ?, ?)");

  const project = process.env.FAKE_CLAUDE_PROJECT || "live-verify";
  pfStmt.run(slug, project, "dev");
  psDel.run(slug);
  for (let i = 0; i < stepCount; i++) psStmt.run(slug, i, `step ${i+1}`, "pending");

  assistantText(`Starting session ${cid} for ${slug}.`);

  const tickMs = Math.max(50, Math.floor(totalMs / stepCount));
  for (let i = 0; i < stepCount; i++) {
    // mark step i as in_progress
    db.prepare("UPDATE progress_steps SET state = 'in_progress' WHERE slug = ? AND step_index = ?").run(slug, i);
    assistantTool("Bash", { command: `echo step ${i+1}` });
    await new Promise(r => setTimeout(r, tickMs));
    if (wantFail && i === Math.floor(stepCount / 2)) {
      assistantText(`Forced failure midway at step ${i+1}.`);
      close(db);
      process.exit(2);
    }
    db.prepare("UPDATE progress_steps SET state = 'completed' WHERE slug = ? AND step_index = ?").run(slug, i);
  }

  // Mark progress_files inactive (session finished)
  db.prepare("UPDATE progress_files SET is_active = 0, completed_at = CURRENT_TIMESTAMP WHERE slug = ?").run(slug);
  assistantText("Session complete.");
  close(db);
  process.exit(0);
})().catch(e => {
  process.stderr.write(`fake-claude error: ${e.message}\n`);
  process.exit(1);
});
