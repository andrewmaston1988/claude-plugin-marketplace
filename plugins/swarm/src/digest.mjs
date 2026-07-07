import { resultPath } from "./results.mjs";

export const DIGEST_ID = "__digest";

// The digest leaf RETURNS text; the ENGINE writes digest.md from its output.
// The leaf therefore needs only Read — never Write.
const DIGEST_TOOLS = "Read";

function digestPrompt(plan) {
  const goal = plan.goal || "(no goal line provided in the manifest)";
  const pathLines = plan.tasks
    .map((t) => `- ${t.id}: ${resultPath(plan.resultsDir, t.id)}`)
    .join("\n");

  let prompt = `You are the digest stage of a swarm run. The leaf tasks have completed and their raw outputs are on disk. Your single job: compress them for the orchestrating session without losing what matters.

Goal of this run: ${goal}

Result files — Read each one yourself; the JSON "output" field holds the leaf's raw output:
${pathLines}

Compression rules:
- At most 5 bullets per leaf (≤5). Never inline long raw output.
- Three-band compression: (1) full fidelity with file:line references for anything the instructions below name as must_be_sure; (2) one line per relevant finding; (3) drop noise entirely.
- Structure: headlines first — one line per leaf — then body detail beneath.
- Leaf accounting: account for every leaf listed above, including failed or empty ones; say so explicitly rather than omitting them.

Required sections:
- "## PROVEN / OPEN ledger" — PROVEN rows carry evidence (file:line or reproduced output); OPEN rows are unresolved questions or unverified claims.
- "## Drill-down" — which raw result files merit a full read by the orchestrating session, and why.

Return the digest as your final response text. Do not write any files — the engine writes digest.md from your output.`;

  if (plan.digest?.instructions) {
    prompt += `\n\nAdditional instructions from the manifest:\n${plan.digest.instructions}`;
  }
  return prompt;
}

// Synthesize the digest task: depends on every leaf, runs on the plan-named
// model, read-only toolset, in the manifest's cwd.
export function buildDigestTask(plan) {
  const timeoutMs = Math.max(...plan.tasks.map((t) => t.timeoutMs || 0)) || 600000;
  return {
    id: DIGEST_ID,
    prompt: digestPrompt(plan),
    model: plan.digest.model,
    allowedTools: DIGEST_TOOLS,
    cwd: plan.cwd,
    originalCwd: plan.cwd,
    scratchRedirect: false,
    timeoutMs,
    after: plan.tasks.map((t) => t.id),
    isDigest: true,
  };
}
