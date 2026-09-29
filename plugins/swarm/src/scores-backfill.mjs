import { isAliasModel } from "./scores.mjs";

// ── backfill-realmodel: repair rows filed under a bare Claude alias ───────────
//
// `grade --init` used to copy the manifest's authored alias verbatim, so the
// store files one model under two identities and overall()/frontier() rank the
// alias as a rival model. The leaf's OWN TRANSCRIPT is the only thing that names
// the concrete id the runner invoked — a "runs before date X were Opus 4.8" table
// is the same inference that caused the defect. One alias resolving to two ids
// across rows is expected, not an error: `opus` meant claude-opus-4-8 before it
// meant claude-opus-5, which is exactly why the transcript is the source.

// Distinct models a Claude-CLI stream-json transcript reports on its assistant
// events. A torn tail, a non-Claude runner's plain log, and an empty file all
// name nothing — and nothing is not an answer, so the caller drops the row
// rather than guessing one.
export function transcriptModels(text) {
  if (typeof text !== "string") return [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // not an event — a truncated tail, or a non-Claude runner's log
    }
    const model = event?.type === "assistant" ? event.message?.model : null;
    if (typeof model === "string" && model.trim()) seen.add(model.trim());
  }
  return [...seen];
}

// Rewrite every alias-named row to the model its transcript reports. Pure over
// the store TEXT and a `readTranscript(resultsDir, leaf) -> string | null`
// reader, so the CLI owns the file and this owns the decision.
//
// A row whose transcript names no model — or names more than one — is DROPPED,
// never guessed: a wrong attribution silently moves a model's average, and a
// grade recorded against the wrong model is a verdict nobody gave. Lines that
// are not alias rows pass through verbatim, so the diff a backfill produces is
// exactly the rows it changed.
export function backfillRealmodel(storeText, { readTranscript }) {
  const counts = new Map(); // JSON-encoded [alias, model] — a resultsDir or model may hold any separator
  const dropped = [];
  const out = [];
  let changed = 0;
  for (const line of String(storeText ?? "").split("\n")) {
    if (!line.trim()) { out.push(line); continue; }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      out.push(line); // a torn tail write from a concurrent append — copy it, never destroy it
      continue;
    }
    if (!isAliasModel(row?.model)) { out.push(line); continue; }
    const text = readTranscript(row.resultsDir, row.leaf);
    const models = transcriptModels(text);
    if (models.length !== 1) {
      dropped.push({
        resultsDir: row.resultsDir,
        leaf: row.leaf,
        alias: row.model,
        reason: text == null
          ? "transcript unreadable"
          : models.length
            ? `transcript names ${models.length} models — ambiguous, so either pick is a guess`
            : "transcript names no model",
      });
      continue;
    }
    out.push(JSON.stringify({ ...row, model: models[0] }));
    const key = JSON.stringify([row.model, models[0]]);
    counts.set(key, (counts.get(key) || 0) + 1);
    changed += 1;
  }
  const mapping = [...counts.entries()]
    .map(([key, n]) => { const [alias, model] = JSON.parse(key); return { alias, model, n }; })
    .sort((x, y) => x.alias.localeCompare(y.alias) || x.model.localeCompare(y.model));
  return { text: out.join("\n"), changed, mapping, dropped };
}
