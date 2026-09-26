// Cues: per-operator input detectors written by the model from the sample, validated against the corpus.
// Each cue = { id, pattern, flags, meaning, note } — pattern is a JS regex in the operator's own language.
import { runClaude } from "./distil.mjs";

export const CUES_PROMPT = `Below is a stratified sample of messages one person typed to a coding assistant, and a profile of them. Write the parser: a list of concrete textual cues in this person's own phrasing whose presence changes how a message should be read, and what each one means coming from them. Only cues a cold reader would misread — a hedge that is really an instruction, a question that is really a go-ahead, a one-word reply that carries a verdict, a marker of a repeat request, a scope fence, a quoted-text-then-reaction shape. Each cue must be something a regular expression can match literally in their language; no cue for things every reader already understands.

Output ONLY a JSON array, no prose, no code fence. Each element:
{"id": "kebab-case", "pattern": "<JavaScript regex source, no delimiters>", "flags": "i", "meaning": "<what this shape means from this person, one sentence>", "note": "<one-line instruction to the assistant when it fires>"}

Between 8 and 20 cues. Patterns must be specific enough not to fire on most messages. Escape backslashes for JSON.

--- PROFILE ---

`;

export function buildCuesPrompt(sampleMarkdown, profile) {
  return CUES_PROMPT + profile + "\n\n--- SAMPLE ---\n\n" + sampleMarkdown;
}

export function parseCues(text) {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("cues output contains no JSON array:\n" + text.slice(0, 300));
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("cues output is not an array");
  return arr.filter(c => c && typeof c.id === "string" && typeof c.pattern === "string" && typeof c.note === "string")
    .map(c => ({ id: c.id, pattern: c.pattern, flags: typeof c.flags === "string" ? c.flags.replace(/[^gimsuy]/g, "") : "i", meaning: String(c.meaning || ""), note: c.note }));
}

export function compileCue(c) {
  try { return new RegExp(c.pattern, c.flags.replace("g", "")); } catch { return null; }
}

// Measure each cue against the corpus; drop ones that don't compile or fire on nothing / on everything.
export function validateCues(cues, turns, { maxRate = 0.35, maxExamples = 3 } = {}) {
  const typed = turns.filter(t => t.kind === "typed");
  const kept = [], dropped = [];
  for (const c of cues) {
    const re = compileCue(c);
    if (!re) { dropped.push({ ...c, why: "does not compile" }); continue; }
    const hits = typed.filter(t => re.test(t.text));
    const rate = typed.length ? hits.length / typed.length : 0;
    if (hits.length === 0) { dropped.push({ ...c, why: "fires on nothing in the corpus" }); continue; }
    if (rate > maxRate) { dropped.push({ ...c, why: `fires on ${Math.round(rate * 100)}% of turns` }); continue; }
    kept.push({ ...c, enabled: true, fires: hits.length, rate: Math.round(rate * 1000) / 10, examples: hits.slice(0, maxExamples).map(h => h.text.slice(0, 140)) });
  }
  return { kept, dropped };
}

export function runCues(text, cues, { max = 3 } = {}) {
  const out = [];
  for (const c of cues) {
    if (c.enabled === false) continue;
    const re = compileCue(c);
    if (re && re.test(text)) out.push({ id: c.id, note: c.note });
    if (out.length >= max) break;
  }
  return out;
}

export function distilCues(sampleMarkdown, profile, opts = {}) {
  const out = runClaude(buildCuesPrompt(sampleMarkdown, profile), opts);
  return parseCues(out);
}
