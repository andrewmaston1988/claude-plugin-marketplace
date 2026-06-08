// Step 4 — doc impact assessment via claude -p Haiku.
// Mirrors merge.py: step_4_doc_impact, gather_diff_summary, gather_doc_excerpts,
// extract_json, _apply_doc_edit, run_claude.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runGit, gitAddWithRetry } from "./rebase.mjs";
import { loadPipelineConfig } from "../../../src/pipeline-config.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Prompt ─────────────────────────────────────────────────────────────────────

const PROMPT_DOC_IMPACT = `You are assessing whether a merged branch requires documentation edits.

Return ONLY this JSON object (no prose, no code fences):
{"claude_md": {"section": "<heading>", "edit": "<replacement markdown>"} | null,
 "readme": {"section": "<heading>", "edit": "<replacement markdown>"} | null,
 "docs": {"<relative/path.md>": {"section": "<heading>", "edit": "<replacement markdown>"}, ...}}

Rules for the "edit" field:
- It is the BODY of the section ONLY. Do NOT include the section's own heading
  line — the heading is rewritten by the caller from the "section" value.
- Do NOT include section separators (\`---\`) — those belong to the surrounding
  document, not the section body.
- Use null if no edit is warranted.

Only propose edits when the diff shows a change in runtime behaviour, CLI
flags, module responsibilities, or user-visible commands. Cosmetic changes do
not require doc edits.

Diff summary (file list + first 40 lines of each significant file's diff):
---
{diff_summary}
---

Candidate doc paths and excerpts:
---
{doc_excerpts}
---
`;

// ── JSON extraction ─────────────────────────────────────────────────────────────

export function extractJson(text) {
  const m = /\{.+\}/s.exec(text || "");
  if (!m) return null;
  try { return JSON.parse(m[0]); }
  catch { return null; }
}

// ── Diff summary ───────────────────────────────────────────────────────────────

export function gatherDiffSummary(repoDir, branch, targetBranch = "main", { maxFiles = 20, maxLines = 40 } = {}) {
  const fileResult = runGit(["diff", "--name-only", `${targetBranch}...${branch}`], repoDir, { check: false });
  const files = fileResult.stdout.split("\n").map(l => l.trim()).filter(Boolean).slice(0, maxFiles);
  const lines = [`Files changed vs ${targetBranch}: ${files.length}`];
  for (const f of files) {
    lines.push(`--- ${f}`);
    const d = runGit(["diff", `${targetBranch}...${branch}`, "--", f], repoDir, { check: false });
    const snippet = d.stdout.split("\n").slice(0, maxLines).join("\n");
    lines.push(snippet);
  }
  return lines.join("\n");
}

// ── Doc excerpts ───────────────────────────────────────────────────────────────

export function gatherDocExcerpts(docPaths, maxChars = 800) {
  const blocks = [];
  for (const p of docPaths) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8").slice(0, maxChars);
    blocks.push(`--- ${p}\n${text}`);
  }
  return blocks.join("\n");
}

// ── Doc edit application ───────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingSectionHeading(body, section) {
  return body.replace(new RegExp(`^\\s*#{1,6}\\s*${escapeRegex(section)}\\s*\n+`), "");
}

export function applyDocEdit(docPath, edit) {
  if (!existsSync(docPath)) return;
  const section = (edit || {}).section;
  let body = (edit || {}).edit;
  if (!section || body == null) return;

  let text = readFileSync(docPath, "utf8");
  body = stripLeadingSectionHeading(body, section);

  const headRe = new RegExp(`^(#{1,6})\\s*${escapeRegex(section)}\\s*$`, "m");
  const m = headRe.exec(text);
  if (!m) {
    writeFileSync(docPath, text.trimEnd() + `\n\n## ${section}\n\n${body.trimEnd()}\n`, "utf8");
    return;
  }

  const level = m[1].length;
  const start = m.index + m[0].length;
  const tail = text.slice(start);
  const nextRe = new RegExp(`^#{1,${level}}\\s`, "m");
  const nm = nextRe.exec(tail);
  const end = nm ? start + nm.index : text.length;

  const sectionText = text.slice(start, end);
  const sepMatch = /\n(---+)\s*\n\s*$/.exec(sectionText);
  const trailingSep = sepMatch ? `${sepMatch[1]}\n\n` : "";

  writeFileSync(
    docPath,
    text.slice(0, m.index) +
    `${m[1]} ${section}\n\n${body.trimEnd()}\n\n${trailingSep}` +
    text.slice(end),
    "utf8",
  );
}

// ── claude -p helper ───────────────────────────────────────────────────────────

export function runClaude(prompt, model) {
  const result = spawnSync("claude", ["-p", "--model", model], {
    input: prompt,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`claude -p --model ${model} failed:\n${(result.stderr || "").trim()}`);
  }
  return result.stdout || "";
}

// ── Step 4 ─────────────────────────────────────────────────────────────────────

export async function step4DocImpact(projectDir, plansRepo, project, branches, { candidateDocs = null, targetBranch = "main", _cfg } = {}) {
  const cfg = _cfg ?? loadPipelineConfig();
  if (!cfg?.merge?.doc_impact_enabled) {
    process.stdout.write("[4] doc-impact disabled (set merge.doc_impact_enabled to enable)\n");
    return;
  }

  const docs = candidateDocs ?? [
    join(PLUGIN_ROOT, "REFERENCE.md"),
    join(projectDir, "README.md"),
    join(projectDir, "CLAUDE.md"),
  ].filter(existsSync);

  for (const branch of branches) {
    process.stdout.write(`[4] Assessing doc impact for ${branch}\n`);
    const diffSummary = gatherDiffSummary(projectDir, branch, targetBranch);
    const excerpts = gatherDocExcerpts(docs);
    const prompt = PROMPT_DOC_IMPACT
      .replace("{diff_summary}", diffSummary)
      .replace("{doc_excerpts}", excerpts);

    let response;
    try { response = runClaude(prompt, cfg.models.doc_impact); }
    catch (e) {
      process.stderr.write(`[4] WARN: claude -p failed for ${branch}: ${e.message}\n`);
      continue;
    }

    const parsed = extractJson(response);
    if (!parsed) {
      process.stderr.write(`[4] WARN: could not parse doc-impact response for ${branch}\n`);
      continue;
    }

    if (parsed.claude_md) {
      applyDocEdit(join(plansRepo, "CLAUDE.md"), parsed.claude_md);
      await gitAddWithRetry(plansRepo, "CLAUDE.md");
    }
    if (parsed.readme) {
      applyDocEdit(join(projectDir, "README.md"), parsed.readme);
      await gitAddWithRetry(projectDir, "README.md");
    }
    for (const [rel, edit] of Object.entries(parsed.docs || {})) {
      applyDocEdit(join(plansRepo, rel), edit);
      await gitAddWithRetry(plansRepo, rel);
    }
  }
}
