// Bundled hook templates written by `pipeline setup` to ~/.pipeline/hooks/.

export const ON_MERGE_TEMPLATE = `import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const localBin    = join(homedir(), ".local", "bin");
const gh          = process.platform === "win32" ? join(localBin, "gh.exe") : join(localBin, "gh");
const ghEnv       = { ...process.env, PATH: \`\${localBin};\${process.env.PATH}\` };

const project     = process.env.PIPELINE_PROJECT       ?? "?";
const feature     = process.env.PIPELINE_FEATURE       ?? "?";
const branch      = process.env.PIPELINE_BRANCH        ?? "?";
const projectRoot = process.env.PIPELINE_PROJECT_ROOT  ?? "";

// Resolve pipeline CLI — prefer the plugin cache copy so it matches the installed version.
const pluginCacheBase = join(homedir(), ".claude", "plugins", "cache", "andrewmaston1988-claude-plugins", "pipeline", "0.1.0");
const pipelineBin = join(pluginCacheBase, "bin", "pipeline.mjs");

// Fetch the full pipeline row in one call — pr_title, d_model, target_branch.
const rowResult = spawnSync(process.execPath, [pipelineBin, "row-get", project, feature], {
  encoding: "utf8", env: process.env,
});
let row = {};
try { row = JSON.parse(rowResult.stdout?.trim() || "{}"); } catch {}

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
    const summary = spawnSync("claude", ["-p", prompt, "--model", "claude-haiku-4-5-20251001", "--temperature", "0"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    });
    if (summary.status === 0 && summary.stdout?.trim()) {
      diffSummary = summary.stdout.trim();
    }
  }
}

// Build commit body: diff summary + Co-Authored-By trailer.
const trailerLines = [];
if (dModel) {
  // Map model IDs to display names for the Co-Authored-By trailer.
  const MODEL_DISPLAY = {
    "claude-sonnet-4-6":         "Claude Sonnet 4.6",
    "claude-opus-4-8":           "Claude Opus 4.8",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "claude-fable-5":            "Claude Fable 5",
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
