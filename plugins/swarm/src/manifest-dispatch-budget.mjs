// The pre-run dispatch budget: the worst-case measurable prompt a task's
// placeholders can expand to, and win32's command-line ceiling check measured
// through the same buildDispatch/toSpawnable path the scheduler spawns with.

import { buildDispatch, toSpawnable, windowsCommandLineLength } from "./dispatch.mjs";
import { withLeafNotices } from "./leaf-notices.mjs";
import { TEMPLATE_RE } from "./coverage.mjs";
import { ITEM_TEMPLATE_RE_G } from "./manifest-relations.mjs";
import { isSentinelModel } from "./manifest-task-policy.mjs";

// win32's CreateProcess caps a whole command line at 32,767 characters; a
// leaf whose real argv exceeds this can never spawn (ENAMETOOLONG). 32,000
// is that cap less headroom. A resultPath placeholder resolves to a real
// filesystem path — 260 is Windows' own legacy MAX_PATH, the same ceiling
// that path would be bound by at runtime. FOREACH_ITEM_MAX bounds a forEach
// template's {{item}}/{{index}} — a result-inline cap says nothing about how
// long a forEach item can be, so it gets its own named ceiling.
const WIN_CMDLINE_MAX = 32000;
const RESULT_PATH_MEASURE_LEN = 260;
export const FOREACH_ITEM_MAX = 4000;

// Worst-case measurable prompt: the runtime templater (substituteTemplates)
// needs plan.resultsDir and can't run at validate time, so placeholders are
// substituted with filler at their ceiling instead — a manifest that would
// only overflow once the real value lands must fail now, not mid-run.
export function measurablePrompt(prompt, cfg) {
  const resultCap = cfg.resultInlineCap ?? 4000;
  return String(prompt || "")
    .replace(TEMPLATE_RE, (whole, kind) => "x".repeat(kind === "result" ? resultCap : RESULT_PATH_MEASURE_LEN))
    .replace(ITEM_TEMPLATE_RE_G, () => "x".repeat(FOREACH_ITEM_MAX));
}

// win32 only: the command line the scheduler would spawn for each leaf, the
// engine's own notice included — measured through buildDispatch + toSpawnable in
// CreateProcess quoting, so what validates is what spawns.
export function checkCommandLineLengths(tasks, cfg, io, errors, label) {
  if (io.platform !== "win32") return;
  // `resolveExecutable` shells out to `where` (up to 5s) per distinct command —
  // every leaf in a manifest resolves the same claudePath, so cache it once
  // per validate call instead of once per task.
  const resolveCache = new Map();
  for (const t of tasks) {
    if (isSentinelModel(t.model)) continue;
    // A malformed task (missing prompt/model) is already reported by
    // validateTaskShapes — measuring it here would dispatch garbage argv.
    if (typeof t.model !== "string" || !t.model || typeof t.prompt !== "string") continue;
    const author = measurablePrompt(t.prompt, cfg);
    let dispatch;
    try {
      dispatch = buildDispatch(t, author, cfg);
      const sent = withLeafNotices(author, t, cfg, dispatch.runner);
      dispatch = sent === author ? dispatch : buildDispatch(t, sent, cfg);
    } catch {
      // Provider identity, enabled-state, governance, and task-policy errors
      // are reported by normalization. They must not escape as an unlabelled
      // dispatch exception while the validator is collecting all diagnostics.
      continue;
    }
    const { cmd, args } = toSpawnable(dispatch.argv, { _platform: io.platform, _cache: resolveCache });
    const len = windowsCommandLineLength([cmd, ...args]);
    if (len > WIN_CMDLINE_MAX) {
      errors.push(
        `${label(t)}: win32 command line would be ${len} characters, over the ${WIN_CMDLINE_MAX}-character ` +
        `limit — point the leaf at a file holding its instructions instead of inlining it in the prompt`
      );
    }
  }
}
