import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./config.mjs";
import { resultPath } from "./results.mjs";

export const DIGEST_ID = "__digest";

// The digest leaf RETURNS text; the ENGINE writes digest.md from its output.
// The leaf therefore needs only Read — never Write. Report mode is the one
// exception: it also WRITES report.md, so it earns Write.
const DIGEST_TOOLS = "Read";
const DIGEST_TOOLS_REPORT = "Read,Write";

export function reportPath(resultsDir) {
  return join(resultsDir, "report.md");
}

// A named drafting directory. Report mode asks for a document long enough that
// one-pass composition shows — the model needs somewhere to draft, re-read, and
// cut before it commits. Naming the directory is the whole mechanism: the leaf
// writes where it is told.
export function scratchPath(resultsDir) {
  return join(resultsDir, "scratch-__digest");
}

// Phase 1 of report mode. The leaf expands into report.md; only then does it
// compress for the return. Compressing a document it just reasoned through beats
// compressing raw results cold.
//
// The spine (leaf accounting, the ledger) is mandated because it is true of every
// run. The BODY is deliberately free: a code audit and a research sweep want
// different documents, and a fixed template is a straitjacket on one of them.
//
// The leaf must NOT write the header — the engine prepends a deterministic one
// (renderProvenance) so the run's numbers cannot be fumbled in transcription.
function reportPhase(plan) {
  const steer = typeof plan.digest.report === "string" ? plan.digest.report.trim() : "";
  return `

## PHASE 1 — write the report (do this FIRST)

Draft, then revise, then commit. You have two paths and you write to nowhere else:
- Drafting space (use it freely): ${scratchPath(plan.resultsDir)}
- The finished report, and nothing else:  ${reportPath(plan.resultsDir)}

**Write a draft first, re-read it, and cut.** A report worth reading is not composed in one pass. Draft into the scratch directory, read your own draft back, and interrogate it against the checklist below before you write the final file. The last thing you do is cut — if a section survives only because you wrote it, delete it.

This is the document a human reads to understand what this run found and why. It is NOT the digest — do not compress it. Expand: quote the evidence, draw the inferences across leaves that no single leaf could draw, say what you actually think.

**The report is about its SUBJECT, not about this run.** The reader commissioned the process; they do not want the blow-by-blow. **Never name a leaf, a model, a token count, or a verifier verdict as something the report talks ABOUT.** State a finding as a finding — not "the verifier confirmed X", just "X (file:line)". Do not write a "leaf accounting" section, a model/duration table, or any run mechanics — the engine appends a one-line run footnote itself. If coverage is incomplete, say plainly in the body what is NOT covered and what that means for the reader — never which component failed.

**Write your OWN title.** Start the file with a single \`# \` heading naming the subject (the goal above tells you what it is). The engine no longer writes a title — it only appends a run footnote at the very bottom.

Required, in every report:
- "## PROVEN / OPEN ledger" — PROVEN rows carry evidence (file:line or reproduced output); OPEN rows are unresolved questions or unverified claims. A finding a truncated verifier never saw is OPEN, never PROVEN.

The body around it is YOURS. Shape it to this run: a code audit wants findings and file:line evidence; a research sweep wants a narrative that draws inferences across leaves; a generation run wants the work itself.

**Do not reach for the default report.** Left alone, a model writes the same document every time — "Executive Summary", then "Key Findings" in a list of three, then "Recommendations", then "Next Steps", then a Conclusion restating the Summary — and it writes it regardless of what the run actually was. That shape is a reflex, not a choice: it fits an audit and a research sweep and a poem equally badly. If a section of your outline would appear no matter what this run had found, cut it and write the section this run actually earned.

**The revision checklist — run your draft against this before writing the final file:**
- Would this section appear no matter what the run had found? Cut it.
- Does a heading or a number encode something true — does the order actually mean something? If not, it is decoration. Cut it.
- Does the body restate the ledger, or re-list the run's mechanics the header already carries? Each part does one job: the header is provenance, the ledger is epistemics, the body is the argument. Say a thing in the one place it belongs.
- Is every finding "critical"? Then none of them reads as critical. Spend emphasis once.
- Is there a section you had nothing to say in, and padded? Delete it — a short report that earns every line beats a long one that doesn't.

**Two claims-you-cannot-cash to avoid — both are how a report over-reaches its evidence:**
- **Scaffolding is not rot.** A field or tunable that is defined-but-unread is a DEFECT only if it sits in a SHIPPED system that comments assert it works, with nothing coming to wire it. A field authored ahead of a NAMED, live plan sub-phase is scaffolding — recommending its deletion destroys design intent the plan promises. Before you call anything "dead", check whether a plan sub-phase will consume it. The usual real defect is narrower: a COMMENT written in the present tense about behaviour that does not exist yet. Flag the comment, not the field.
- **Preserve scope.** When you characterise what a plan or a comment intends, carry its scope with it. "The plan changes how the gun fires" is not "the plan replaces the melee model". A true citation of an exact quote can still MISREPRESENT by widening it. If the source's own wording is loose, quote it and say it is loose — do not resolve the ambiguity toward the more dramatic sentence.

**Optional markers the HTML renderer understands** — reach for these instead of inventing ad-hoc emphasis; each is something you would write anyway, and the renderer upgrades them into styled components (they are semantic, NOT a layout — the body shape stays yours):
- Lead a ledger row with a bare verdict word — \`PROVEN\` / \`OPEN\` / \`REFUTED\` / \`UNVERIFIED\` / \`CONFIRMED\` / \`OVERCLAIM\` — and it renders as a coloured badge.
- Write \`operator-feel, unresolved\` on any judgement only a human playtest can settle — it renders as an amber "playtest call" chip.
- Cite code as \`path:line\` (e.g. \`crafting.gd:4\`) — it renders as a monospace citation span.${steer ? `\n\nSteering for the body (from the manifest):\n${steer}` : ""}

## PHASE 2 — return the digest

Having written the report, compress IT for the orchestrating session, under the rules below. The report is the long form; the digest is the handoff. Mention ${reportPath(plan.resultsDir)} once so the session knows the long form exists.`;
}

function digestPrompt(plan) {
  const goal = plan.goal || "(no goal line provided in the manifest)";
  const pathLines = plan.tasks
    .map((t) => `- ${t.id}: ${resultPath(plan.resultsDir, t.id)}`)
    .join("\n");
  const report = plan.digest?.report ? reportPhase(plan) : "";

  let prompt = `You are the digest stage of a swarm run. The leaf tasks have completed and their raw outputs are on disk. Your single job: compress them for the orchestrating session without losing what matters.

Goal of this run: ${goal}

Result files — Read each one yourself; the JSON "output" field holds the leaf's raw output:
${pathLines}
${report}

Compression rules:
- One bullet per real finding — no padding to fill, and no arbitrary cap. A leaf with eight findings gets eight bullets; a leaf with one gets one. If a leaf's findings genuinely do not compress, say so rather than truncating them silently. Never inline long raw output.
- Three-band compression: (1) full fidelity with file:line references for anything the instructions below name as must_be_sure; (2) one line per relevant finding; (3) drop noise entirely.
- Structure: headlines first — one line per leaf — then body detail beneath.
- Leaf accounting: account for every leaf listed above, including failed or empty ones; say so explicitly rather than omitting them.

Truncated inputs — check this for every leaf:
- If a result JSON carries a "promptTruncations" field, that leaf was fed only a PREFIX of the named dependency's output: it never saw the rest. A verifier in this state checked only the findings that fit, and the remainder is UNVERIFIED — not refuted, simply unchecked.
- Say so explicitly: name the affected leaf and dependency, and put the unchecked findings in the ledger as OPEN. They are never PROVEN on that verifier's say-so, and they must not appear as confirmed headlines.

Required sections:
- "## PROVEN / OPEN ledger" — PROVEN rows carry evidence (file:line or reproduced output); OPEN rows are unresolved questions or unverified claims.
- "## Drill-down" — which raw result files merit a full read by the orchestrating session, and why.

Return the digest as your final response text. ${plan.digest?.report
    ? `The ONLY file you write is the report named above — the engine writes digest.md from your returned text.`
    : `Do not write any files — the engine writes digest.md from your output.`}`;

  if (plan.digest?.instructions) {
    prompt += `\n\nAdditional instructions from the manifest:\n${plan.digest.instructions}`;
  }
  return prompt;
}

// Synthesize the digest task: depends on every leaf, runs on the plan-named
// model, read-only toolset, in the manifest's cwd.
export function buildDigestTask(plan) {
  const timeoutMs = Math.max(...plan.tasks.map((t) => t.timeoutMs || 0)) || DEFAULT_TIMEOUT_MS;
  return {
    id: DIGEST_ID,
    prompt: digestPrompt(plan),
    model: plan.digest.model,
    allowedTools: plan.digest.report ? DIGEST_TOOLS_REPORT : DIGEST_TOOLS,
    cwd: plan.cwd,
    originalCwd: plan.cwd,
    scratchRedirect: false,
    timeoutMs,
    after: plan.tasks.map((t) => t.id),
    isDigest: true,
  };
}
