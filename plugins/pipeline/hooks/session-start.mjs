#!/usr/bin/env node
// SessionStart hook — injects pipeline DB path, CLAUDE.md location, and CLI reminders
// as additionalContext so Claude doesn't need to re-derive them mid-session.
// Skips in autonomous orchestrator sessions (CORRELATION_ID is set).
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", c => { stdin += c; });
  process.stdin.on("end", () => {
    // Autonomous pipeline sessions have CORRELATION_ID — skip the injection there.
    if (process.env.CORRELATION_ID) {
      process.exit(0);
    }

    // Import getPaths lazily so the module error (if any) doesn't crash the hook.
    // Use pathToFileURL — on Windows, dynamic import() rejects bare drive-letter paths.
    import(pathToFileURL(join(PLUGIN_ROOT, "src", "paths.mjs")).href)
      .then(({ getPaths }) => {
        const paths = getPaths();
        const dbPath = join(paths.dataDir, "pipeline.db");
        const claudeMdPath = join(PLUGIN_ROOT, "CLAUDE.md");

        const context = [
          "# Pipeline plugin context",
          "",
          `Pipeline DB: \`${dbPath}\` — \`pipeline doctor\` to verify path + health. See \`${claudeMdPath}\` for config / worktree / diagnostics.`,
          "",
          "**DB access rule**: use \`pipeline\` CLI, never query pipeline.db directly. The pre-tool-use hook enforces this.",
        ].join("\n");

        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: context,
          },
        }) + "\n");
        process.exit(0);
      })
      .catch(() => {
        // If paths.mjs fails to load, exit cleanly — hook failure must not block the session.
        process.exit(0);
      });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
