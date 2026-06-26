import {
  close,
  progressCreate, progressGet, progressMark, progressDelete,
  progressListActive, progressResumeIndex, progressMdString,
  progressSetPid, progressNoteAppend,
  progressListActiveAcrossProjects,
} from "../db/index.mjs";
import { lookupProjectOrFail, openUnifiedOrFail } from "./project-lookup.mjs";

const ACTIVE_VERBS = {
  read: "Reading", check: "Checking", mark: "Marking",
  write: "Writing", update: "Updating", implement: "Implementing",
  run: "Running", verify: "Verifying", create: "Creating",
  generate: "Generating", build: "Building", commit: "Committing",
  push: "Pushing", merge: "Merging", answer: "Answering",
  investigate: "Investigating", chain: "Chaining", identify: "Identifying",
  move: "Moving", clean: "Cleaning", rebase: "Rebasing",
  close: "Closing", checkout: "Checking out", fix: "Fixing",
  test: "Testing", delete: "Deleting", add: "Adding",
  remove: "Removing", rename: "Renaming", review: "Reviewing",
  do: "Doing",
};

function activeForm(text) {
  if (!text) return text;
  const parts = text.split(/\s+/);
  const first = parts[0].toLowerCase().replace(/[.,;:]$/, "");
  if (ACTIVE_VERBS[first]) {
    const rest = parts.slice(1).join(" ");
    return rest ? `${ACTIVE_VERBS[first]} ${rest}` : ACTIVE_VERBS[first];
  }
  return text;
}

function slugPrefix(slug) {
  const iu = slug.indexOf("_");
  const ih = slug.indexOf("-");
  const cands = [iu, ih].filter(i => i >= 0);
  if (!cands.length) return slug.toLowerCase();
  return slug.slice(0, Math.min(...cands)).toLowerCase();
}

function progressTasksPayload(parsed) {
  const prefix = parsed.prefix || slugPrefix(parsed.slug || "");
  return (parsed.steps || []).map(step => {
    const subject = prefix ? `${prefix}: ${step.text}` : step.text;
    const active = activeForm(step.text);
    const activeF = prefix ? `${prefix}: ${active}` : active;
    return { subject, description: step.text, activeForm: activeF, status: step.state };
  });
}

function fmtProgressSnippet(db) {
  let rows;
  try { rows = progressListActiveAcrossProjects(db); } catch { return ""; }
  if (!rows || !rows.length) return "";
  const parsed = rows[0];
  const STATE_MARKER = { completed: "x", in_progress: "~", pending: " " };
  const steps = (parsed.steps || []).map(s => [STATE_MARKER[s.state] || " ", s.text]);
  if (!steps.length) return "";
  const total = steps.length;
  const curIdx = steps.findIndex(([s]) => s !== "x");
  if (curIdx === -1) return "";
  const curState = steps[curIdx][0];

  function trunc(text, n = 23) {
    text = text.replace(/^\[\d+\/\d+\]\s*/, "");
    return text.length <= n ? text : text.slice(0, n - 1) + "…";
  }

  const lines = [];
  let prevDone = -1;
  for (let i = curIdx - 1; i >= 0; i--) {
    if (steps[i][0] === "x") { prevDone = i; break; }
  }
  if (prevDone !== -1) lines.push(`~[${prevDone + 1}/${total}] ${trunc(steps[prevDone][1])}~`);
  if (curState === "~") {
    lines.push(`*[${curIdx + 1}/${total}] ${trunc(steps[curIdx][1])}*`);
  } else {
    lines.push(`_[${curIdx + 1}/${total}] ${trunc(steps[curIdx][1])}_`);
  }
  let after = -1;
  for (let i = curIdx + 1; i < steps.length; i++) {
    if (steps[i][0] === " ") { after = i; break; }
  }
  if (after !== -1) lines.push(`[${after + 1}/${total}] ${trunc(steps[after][1])}`);
  const nOut = steps.filter(([s]) => s === " ").length;
  const nDone = steps.filter(([s]) => s === "x").length;
  const shown = after === -1 ? 1 : 2;
  if (nOut > shown) lines.push(`_+${nOut - shown} more (${nDone} done)_`);
  return lines.join("\n");
}

export async function run(cmd, argv) {
  if (cmd === "progress-create") {
    const [project, slug, ...flags] = argv;
    if (!project || !slug) {
      process.stderr.write("usage: progress-create <project> <slug> [--steps ...]\n");
      return 1;
    }
    // Each flag lookup must guard against indexOf returning -1 (flag absent):
    // -1 + 1 = 0 silently picks the FIRST flags element, contaminating the
    // value. Previously, omitting --parent / --prefix made them inherit
    // whichever flag actually came first (commonly "--steps").
    const _flag = (name) => {
      const i = flags.indexOf(name);
      return i !== -1 && i + 1 < flags.length ? flags[i + 1] : null;
    };
    const stepsFlag  = _flag("--steps")  ?? "";
    const parentFlag = _flag("--parent");
    const prefixFlag = _flag("--prefix");
    const steps = stepsFlag
      ? stepsFlag.split("|").map(s => s.trim()).filter(Boolean)
      : [];
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      progressCreate(ctx.db, ctx.project, {
        slug, steps,
        parentSlug: parentFlag || null,
        prefix: prefixFlag || null,
      });
      process.stdout.write("OK\n");
      return 0;
    } finally { close(ctx.db); }
  }

  if (cmd === "progress-mark") {
    const [_unused, slug, indexStr, state, ...flags] = argv;
    // Note: project no longer required for mark (slug is globally unique)
    // Accept positional arg for backward-compat with old <memory-dir> calls but ignore it.
    if (!slug || !indexStr || !state) {
      process.stderr.write("usage: progress-mark <project> <slug> <step-index> <state> [--emit]\n");
      return 1;
    }
    const index = parseInt(indexStr, 10);
    const emit = flags.includes("--emit");
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      progressMark(db, slug, index, state);
      if (emit) {
        const parsed = progressGet(db, slug);
        if (!parsed) { process.stderr.write(`not found: ${slug}\n`); return 1; }
        const tasks = progressTasksPayload(parsed);
        const entry = tasks[index - 1];
        process.stdout.write(JSON.stringify({ subject: entry.subject, status: entry.status }) + "\n");
      } else {
        process.stdout.write("OK\n");
      }
      return 0;
    } catch (e) {
      process.stderr.write(e.message + "\n");
      return 1;
    } finally { close(db); }
  }

  if (cmd === "progress-get") {
    const [_unused, slug, ...flags] = argv;
    if (!slug) {
      process.stderr.write("usage: progress-get <project> <slug> [--format md|json|tasks]\n");
      return 1;
    }
    const fmtIdx = flags.indexOf("--format");
    const fmt = fmtIdx !== -1 ? flags[fmtIdx + 1] : "md";
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      const parsed = progressGet(db, slug);
      if (!parsed) { process.stderr.write(`not found: ${slug}\n`); return 1; }
      if (fmt === "md") {
        const md = progressMdString(db, slug) || "";
        process.stdout.write(md);
      } else if (fmt === "json") {
        process.stdout.write(JSON.stringify({
          slug: parsed.slug, parent: parsed.parent,
          prefix: parsed.prefix ?? null, steps: parsed.steps,
        }, null, 2) + "\n");
      } else {
        process.stdout.write(JSON.stringify(progressTasksPayload(parsed), null, 2) + "\n");
      }
      return 0;
    } finally { close(db); }
  }

  if (cmd === "progress-resume") {
    const [_unused, slug] = argv;
    if (!slug) {
      process.stderr.write("usage: progress-resume <project> <slug>\n");
      return 1;
    }
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      const idx = progressResumeIndex(db, slug);
      if (idx === 0) {
        process.stderr.write("not found: no pending or in_progress steps\n");
        return 1;
      }
      process.stdout.write(`${idx}\n`);
      return 0;
    } finally { close(db); }
  }

  if (cmd === "progress-delete") {
    const [_unused, slug] = argv;
    if (!slug) {
      process.stderr.write("usage: progress-delete <project> <slug>\n");
      return 1;
    }
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      const status = progressDelete(db, slug);
      process.stdout.write(status + "\n");
      return 0;
    } finally { close(db); }
  }

  if (cmd === "progress-list-active") {
    const [project] = argv;
    const wantAll = !project || project === "--all";
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      if (wantAll) {
        const rows = progressListActiveAcrossProjects(db);
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } else {
        const rows = progressListActive(db, { project });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      }
      return 0;
    } finally { close(db); }
  }

  if (cmd === "progress-snippet") {
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      process.stdout.write(fmtProgressSnippet(db));
      return 0;
    } finally { close(db); }
  }

  if (cmd === "progress-note") {
    const [_unused, slug, ...textParts] = argv;
    const text = textParts.join(" ");
    if (!slug || !text) {
      process.stderr.write("usage: progress-note <project> <slug> <text>\n");
      return 1;
    }
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      progressNoteAppend(db, slug, text);
      process.stdout.write("OK\n");
      return 0;
    } finally { close(db); }
  }

  if (cmd === "progress-set-pid") {
    const [_unused, slug, pidStr] = argv;
    if (!slug || !pidStr) {
      process.stderr.write("usage: progress-set-pid <project> <slug> <pid>\n");
      return 1;
    }
    const db = openUnifiedOrFail();
    if (!db) return 1;
    try {
      progressSetPid(db, slug, parseInt(pidStr, 10));
      process.stdout.write("OK\n");
      return 0;
    } finally { close(db); }
  }

  return null;
}
