// `mustRead`: the shape of a leaf's declared reading list, and the separate
// platform-independent check that its runner's transcript can prove it.

import { TEMPLATE_RE, TRANSCRIPT_RUNNERS } from "./coverage.mjs";
import { transcriptRunner } from "./dispatch.mjs";

// More `mustRead` entries than this is an authoring mistake — use an index entry.
export const MUST_READ_MAX_ENTRIES = 500;
const KNOWN_MUST_READ_KEYS = new Set(["path", "lines", "index", "lane"]);

// mustRead shape validation only — the runner check is a
// separate platform-independent pass. Entries are string paths, {path,lines?}
// or {index,lane?}; {{resultPath:<id>}} is the only template, and its id must
// be a declared dependency, the same rule prompts obey.
export function validateMustRead(rawTasks, errors, label) {
  for (const t of rawTasks) {
    if (t.mustRead === undefined) continue;
    const l = label(t);
    // A manifest node is already reported by MANIFEST_BANNED_KEYS; compute and
    // integrate nodes spawn no leaf either, so there is no transcript to check.
    if (t.compute !== undefined || t.integrate !== undefined) {
      errors.push(`${l}: mustRead needs a leaf — this node spawns none`);
      continue;
    }
    if (t.manifest !== undefined) continue; // banned-key path owns the message
    if (!Array.isArray(t.mustRead)) {
      errors.push(`${l}: mustRead must be an array of entries — e.g. ["src/a.mjs", {"path": "b.mjs", "lines": [[1, 200]]}]`);
      continue;
    }
    if (t.mustRead.length === 0) {
      errors.push(`${l}: mustRead is empty — it would prove nothing yet read as complete; list the files the leaf must Read, or drop the field`);
      continue;
    }
    if (t.mustRead.length > MUST_READ_MAX_ENTRIES) {
      errors.push(`${l}: mustRead has ${t.mustRead.length} entries, over the ${MUST_READ_MAX_ENTRIES} limit — declare an index entry ({"index": "<path>"}) the engine expands at check time instead`);
    }
    const deps = new Set(t.after || []);
    const checkTemplate = (s, what) => {
      for (const m of String(s).matchAll(TEMPLATE_RE)) {
        if (m[1] !== "resultPath") {
          errors.push(`${l}: only {{resultPath:<id>}} is substituted in mustRead — '${m[0]}' is not honoured`);
        } else if (!deps.has(m[2])) {
          errors.push(`${l}: mustRead ${what} references {{resultPath:${m[2]}}} but '${m[2]}' is not a declared dependency — add '${m[2]}' to after`);
        }
      }
    };
    const checkLines = (lines) => {
      if (!Array.isArray(lines)) { errors.push(`${l}: mustRead lines must be an array of [start, end] integer pairs`); return; }
      for (const pair of lines) {
        if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || !Number.isInteger(pair[1])) {
          errors.push(`${l}: mustRead lines must be [start, end] integer pairs (got ${JSON.stringify(pair)})`);
        } else if (pair[0] > pair[1]) {
          errors.push(`${l}: mustRead range [${pair[0]}, ${pair[1]}] has start > end`);
        }
      }
    };
    for (const entry of t.mustRead) {
      if (typeof entry === "string") {
        if (!entry) errors.push(`${l}: mustRead path must be a non-empty string`);
        else checkTemplate(entry, "path");
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${l}: mustRead entry must be a string path or a {path}/{index} object (got ${JSON.stringify(entry)})`);
        continue;
      }
      for (const k of Object.keys(entry)) {
        if (!KNOWN_MUST_READ_KEYS.has(k)) errors.push(`${l}: unknown key '${k}' in mustRead entry — known keys: ${[...KNOWN_MUST_READ_KEYS].join(", ")}`);
      }
      if (entry.path !== undefined && entry.index !== undefined) {
        errors.push(`${l}: a mustRead entry has both path and index — use one`);
      } else if (entry.path !== undefined) {
        if (typeof entry.path !== "string" || !entry.path) errors.push(`${l}: mustRead path must be a non-empty string`);
        else checkTemplate(entry.path, "path");
        if (entry.lines !== undefined) checkLines(entry.lines);
      } else if (entry.index !== undefined) {
        if (typeof entry.index !== "string" || !entry.index) errors.push(`${l}: mustRead index must be a non-empty path string`);
        else checkTemplate(entry.index, "index");
        if (entry.lane !== undefined && (!Number.isInteger(entry.lane) || entry.lane < 0)) {
          errors.push(`${l}: mustRead lane must be a non-negative integer (got ${JSON.stringify(entry.lane)})`);
        }
      } else {
        errors.push(`${l}: a mustRead entry must name a path or an index`);
      }
    }
  }
}

// The runner check: mustRead is proven from the leaf's own transcript, which
// coverage.mjs parses for TRANSCRIPT_RUNNERS only — a launch wrapper's unknown
// stdout has nothing to read. Takes `io` for signature parity with
// checkCommandLineLengths but deliberately does NOT gate on io.platform: an
// unsupported runner is rejected everywhere, not just on Windows.
export function validateMustReadRunners(tasks, cfg, io, errors, label, providerRegistry) {
  for (const t of tasks) {
    if (!Array.isArray(t.mustRead)) continue;
    const runner = transcriptRunner(t, cfg, providerRegistry);
    if (!TRANSCRIPT_RUNNERS.has(runner)) {
      errors.push(
        `${label(t)}: mustRead is checked from the leaf's own transcript; runner '${runner}' is not supported — ` +
        `run this task on a Claude, :cloud or codex model, or drop mustRead`);
    }
  }
}
