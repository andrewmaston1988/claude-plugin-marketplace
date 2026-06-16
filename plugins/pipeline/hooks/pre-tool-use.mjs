#!/usr/bin/env node
// PreToolUse hook — warns when Claude queries pipeline.db directly and injects a reminder
// to use the pipeline CLI instead. Never blocks — exit 0 always.
import { pathToFileURL } from "node:url";

const WARN_MSG = [
  "pipeline.db detected: prefer pipeline CLI over direct sqlite.",
  "  /pipeline:pipeline            — row status for this project",
  "  pipeline rows <project>       — list all rows",
  "  pipeline doctor               — DB path, config health, key file locations",
  "  pipeline progress-list-active — active sessions",
].join("\n");

const SQLITE_PATTERNS = [
  /DatabaseSync/,
  /node:sqlite/,
  /from ['"]node:sqlite['"]/,
  /import\(['"]node:sqlite['"]\)/,
  /sqlite3\b/,
];

function looksLikeDirectDbAccess(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  if (!cmd.includes("pipeline.db")) return false;
  return SQLITE_PATTERNS.some(re => re.test(cmd));
}

function looksLikeDirectRead(input) {
  const p = (input.file_path || input.path || "").replace(/\\/g, "/");
  return p.endsWith("pipeline.db");
}

function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", c => { stdin += c; });
  process.stdin.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(stdin); } catch { process.exit(0); }

    const { tool_name: toolName, tool_input: toolInput = {} } = payload;

    let warn = false;
    if (toolName === "Bash" || toolName === "PowerShell") {
      warn = looksLikeDirectDbAccess(toolInput.command || "");
    } else if (toolName === "Read") {
      warn = looksLikeDirectRead(toolInput);
    }

    if (warn) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: WARN_MSG,
        },
      }) + "\n");
    }

    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
