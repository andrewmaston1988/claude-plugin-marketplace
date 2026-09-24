// The `swarm grade --init` skeleton: one row per gradeable leaf, with every
// field a machine can read off the leaf resolved here and every field that is
// judgement left for the grader. Grades are ALWAYS null — an untouched skeleton
// is unappendable by construction, so it cannot land as a grade.
import { UNIVERSAL, CAPABILITY, OUTCOMES } from "./aspects.mjs";

// The placeholder a row keeps when the leaf's own record does not settle it.
export const OUTCOME_CHOICES = `<${OUTCOMES.join(" | ")}>`;

const DOMAIN_HINT = "<one lowercase token: the language or ecosystem the leaf worked in — rust, godot, node, python, docs. Not the repo, not the task>";

// A note is a prompt to the grader, not an essay.
const NOTE_MAX = 200;

const hasOutput = (result) => typeof result?.output === "string" && result.output.trim().length > 0;

// Only the leaf's own recorded state, and only where it is unambiguous.
// `wrong` is never pre-filled — it is the judgement the grader is here to make —
// and a leaf that produced no output cannot be called `completed` however it
// exited, so it keeps the placeholder unless the record says timeout/failed.
export function outcomeFor(result) {
  if (!result || typeof result !== "object") return OUTCOME_CHOICES;
  if (result.timedOut === true) return "timeout";
  if (result.ok === false) return "failed";
  if (result.ok === true && hasOutput(result)) return "completed";
  return OUTCOME_CHOICES;
}

// The leaf's own opening claim: its TL;DR line when it wrote one, else whatever
// it said first.
export function tldrLine(output) {
  if (typeof output !== "string") return "";
  const lines = output.split("\n").map((line) => line.replace(/\r$/, "").trim());
  const line = lines.find((l) => /^tl;dr/i.test(l)) || lines.find((l) => l) || "";
  return line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX)}…` : line;
}

// Quoted and attributed, so the grader reads the leaf's claim rather than a
// verdict someone already reached for them.
export function noteFor(result) {
  const line = tldrLine(result?.output);
  return line ? `leaf says: "${line}"` : "";
}

export function buildSkeleton(leaves, { resultsDir }) {
  return {
    resultsDir,
    session: "<this session's id>",
    rows: leaves.map((l) => ({
      leaf: l.id,
      ...(l.provider ? { provider: l.provider } : {}),
      model: l.model,
      read: { result: l.resultPath, transcript: l.transcriptPath },
      domain: DOMAIN_HINT,
      outcome: outcomeFor(l.result),
      note: noteFor(l.result),
      grades: {
        ...Object.fromEntries(UNIVERSAL.map((a) => [a, null])),
        ...Object.fromEntries(CAPABILITY.map((a) => [a, null])),
      },
    })),
  };
}
