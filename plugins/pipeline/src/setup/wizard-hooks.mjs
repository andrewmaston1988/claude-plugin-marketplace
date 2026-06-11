// Bundled hook templates written by `pipeline setup` to ~/.pipeline/hooks/.

export const ON_MERGE_TEMPLATE = `import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const gh          = process.platform === "win32" ? "gh.exe" : "gh";
const ghEnv       = process.env;

const project     = process.env.PIPELINE_PROJECT       ?? "?";
const feature     = process.env.PIPELINE_FEATURE       ?? "?";
const branch      = process.env.PIPELINE_BRANCH        ?? "?";
const projectRoot = process.env.PIPELINE_PROJECT_ROOT  ?? "";

// Resolve pipeline CLI from the plugin cache — scan version dirs (highest first)
// for the one that actually has the bin, so this survives plugin upgrades.
const pipelinePkgDir = join(homedir(), ".claude", "plugins", "cache", "andrewmaston1988-claude-plugins", "pipeline");
let pipelineBin = "";
try {
  for (const ver of readdirSync(pipelinePkgDir).sort().reverse()) {
    const exe = join(pipelinePkgDir, ver, "bin", "pipeline.mjs");
    if (existsSync(exe)) { pipelineBin = exe; break; }
  }
} catch { /* cache unreadable — pipelineBin stays empty, row lookup is skipped below */ }

// Fetch the full pipeline row in one call — pr_title, d_model, target_branch.
// Skip if the bin couldn't be located; subject/model fall back to defaults below.
let row = {};
if (pipelineBin) {
  const rowResult = spawnSync(process.execPath, [pipelineBin, "row-get", project, feature], {
    encoding: "utf8", env: process.env,
  });
  try { row = JSON.parse(rowResult.stdout?.trim() || "{}"); } catch {}
}

const subject     = row.pr_title || feature;
const dModel      = row.d_model  || null;
const target      = row.target_branch || process.env.PIPELINE_TARGET_BRANCH || "master";

// Generate a 2-3 bullet diff summary via claude -p (Haiku — fast, cheap).
let diffSummary = "";
if (projectRoot) {
  const diff = spawnSync("git", ["-C", projectRoot, "diff", \`\${target}...\${branch}\`, "--stat", "--no-color"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (diff.status === 0 && diff.stdout?.trim()) {
    const prompt = "Summarise this diff in 2-3 concise bullet points for a git commit body. Plain text, no headers, no markdown formatting.\\n\\n" + diff.stdout.trim();
    const summary = spawnSync("claude", ["-p", prompt, "--model", "claude-haiku-4-5", "--temperature", "0"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    });
    if (summary.status === 0 && summary.stdout?.trim()) {
      diffSummary = summary.stdout.trim();
    } else {
      process.stderr.write(\`WARN: claude -p exited \${summary.status}, skipping diff summary\\n\`);
    }
  }
}

// Build commit body: diff summary + Co-Authored-By trailer.
const trailerLines = [];
if (dModel) {
  // Map model IDs to display names for the Co-Authored-By trailer.
  const MODEL_DISPLAY = {
    "claude-haiku-4-5":  "Claude Haiku 4.5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-opus-4-8":   "Claude Opus 4.8",
    "claude-fable-5":    "Claude Fable 5",
  };
  const displayName = MODEL_DISPLAY[dModel] || dModel;
  trailerLines.push(\`Co-Authored-By: \${displayName} <noreply@anthropic.com>\`);
}
const body = [diffSummary, ...trailerLines].filter(Boolean).join("\\n\\n");

const mergeArgs = ["pr", "merge", branch, "--squash", "--delete-branch", "--subject", subject];
if (body) mergeArgs.push("--body", body);

const result = spawnSync(gh, mergeArgs, {
  stdio: "inherit",
  env: ghEnv,
});
process.exit(result.status ?? 1);
`;
