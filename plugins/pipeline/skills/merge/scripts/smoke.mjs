// Step 8 — smoke check: the command under a project CLAUDE.md "smoke" heading.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function out(msg) { process.stdout.write(msg + "\n"); }
function err(msg) { process.stderr.write(msg + "\n"); }

export function readSmokeCommand(projectClaudeMd) {
  if (!existsSync(projectClaudeMd)) return null;
  const text = readFileSync(projectClaudeMd, "utf8");
  // Find the smoke heading, then scan forward within its section for a code fence.
  // Handles prose between heading and fence (e.g. "Run this command:\n```bash\n...").
  const sectionM = /^#+\s+smoke\b[^\n]*/im.exec(text);
  if (!sectionM) return null;
  const after = text.slice(sectionM.index + sectionM[0].length);
  const nextHeading = /^#+\s+/m.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;
  const fenceM = /```(?:bash|sh|powershell|pwsh)?\n([^\n]+)/i.exec(section);
  return fenceM ? fenceM[1].trim() : null;
}

export function step8Smoke(projectDir, smokeCmd) {
  if (!smokeCmd) { out("[8] No smoke command provided; skipping"); return true; }
  out(`[8] Running: ${smokeCmd}`);
  const result = spawnSync(smokeCmd, { shell: true, cwd: projectDir, encoding: "utf8" });
  if (result.status !== 0) {
    err(`BLOCKER: smoke check failed (exit ${result.status})`);
    if (result.stdout) err(result.stdout.slice(-2000));
    if (result.stderr) err(result.stderr.slice(-2000));
    return false;
  }
  out("[8] Smoke check passed");
  return true;
}
