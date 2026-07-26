// onboardingCost() — reads this session's onboarding token cost from its own transcript.
// Onboarding is the fixed prefix (system prompt + tool/MCP schemas + memory/rules) that
// every fan-out leaf re-pays at full rate, with no cross-leaf cache credit. The first
// assistant turn pays it before any conversation accumulates, so its
// input_tokens + cache_creation_input_tokens is the figure a fresh leaf re-pays.
//
// Self-contained: a plugin must run without any other plugin present, so the few lines of
// usage math are reimplemented here rather than imported from checkpoint's context.mjs
// (that reader takes the transcript TAIL for live utilisation — the opposite end).

import { readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FALLBACK_ONBOARDING = 40_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

// [substring, window]. First match wins. Family names, not versioned ids.
const MODEL_WINDOWS = [
  ["claude-opus", 1_000_000],
  ["claude-fable", 1_000_000],
  ["claude-sonnet", 200_000],
  ["claude-haiku", 200_000],
];

export function contextWindowFor(model) {
  if (typeof model === "string") {
    for (const [sub, win] of MODEL_WINDOWS) if (model.includes(sub)) return win;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// Claude Code encodes the project dir by rewriting \ / : to -.
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[\\/:]/g, "-");
}

function defaultProjectsRoot() {
  return join(homedir(), ".claude", "projects");
}

// Newest *.jsonl by mtime under projectsRoot/<encoded-cwd>/ — the actively-written
// transcript is the current session. Null when none is readable.
function newestTranscript(projectsRoot, cwd) {
  const dir = join(projectsRoot, encodeProjectDir(cwd));
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  let best = null, bestMtime = -1;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const p = join(dir, name);
    let mtime;
    try { mtime = statSync(p).mtimeMs; } catch { continue; }
    if (mtime > bestMtime) { bestMtime = mtime; best = p; }
  }
  return best;
}

// First assistant turn carrying a usage object. { model, usage } or null.
function firstAssistantUsage(transcriptPath) {
  let text;
  try { text = readFileSync(transcriptPath, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    const msg = e && e.message;
    if (msg && msg.role === "assistant" && msg.usage) {
      return { model: msg.model ?? null, usage: msg.usage };
    }
  }
  return null;
}

export function onboardingCost({
  cwd = process.cwd(),
  now = new Date(),
  projectsRoot = defaultProjectsRoot(),
} = {}) {
  const date = now.toISOString().slice(0, 10);
  const fallback = {
    onboardingTokens: FALLBACK_ONBOARDING,
    model: null,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    date,
    source: "fallback",
  };

  const transcript = newestTranscript(projectsRoot, cwd);
  if (!transcript) return fallback;
  const hit = firstAssistantUsage(transcript);
  if (!hit) return fallback;

  // The prefix a cold leaf re-pays: uncached input + freshly-cached creation. cache_read
  // is excluded — it is what THIS session reused, not what a fresh leaf must re-establish.
  const u = hit.usage;
  const onboardingTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (!onboardingTokens) return fallback;

  return {
    onboardingTokens,
    model: hit.model,
    contextWindow: contextWindowFor(hit.model),
    date,
    source: "transcript",
  };
}

// Runnable directly: `node onboarding-cost.mjs` prints the figure for the skill to quote.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = onboardingCost();
  const pct = Math.round((100 * r.onboardingTokens) / r.contextWindow);
  process.stdout.write(
    `onboarding ≈ ${r.onboardingTokens.toLocaleString()} tokens ` +
    `(${r.source}${r.model ? `, ${r.model}` : ""}, ` +
    `${pct}% of a ${r.contextWindow.toLocaleString()}-token window, read ${r.date})\n`
  );
}
