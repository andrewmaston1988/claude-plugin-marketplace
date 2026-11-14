#!/usr/bin/env node
// RQ9 — can the tool stop a write it was not asked to make, and prove it did?
//
// Three arms on the same live page, same action, same wait:
//   unguarded        the positive control: the POST must leave and reach the database
//   network-guard    every non-GET request aborted at the network layer
//   action-allowlist the runner refuses to dispatch the click unless the target's declared
//                    method is on its allowlist — a scenario-layer guard, no interception
//
// Evidence is two-sided on purpose: the fixture's access log (did a request leave?) and the
// scratch DB's `rec_feedback` row count (did it land?). A guard that only hides the response
// would pass the log check and fail the DB check.
//
//   node bakeoff/ui-probe/web/run-rq9.mjs [--only cdp]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS, DESKTOP, SHEET_SETTLE_MS, ensureDir, round, sleep, summarise, table,
} from "./lib/harness.mjs";
import { accessLogSize, accessSince, clearFeedback, feedbackRows, startHubFixture } from "./lib/hub.mjs";
import * as probes from "./lib/probes.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = flag("only");
const outFile = join(ARTIFACTS, "rq9.json");
const SETTLE_MS = 1500;          // htmx POST, handler, DB commit, log flush
const ACTION_INDEX = 1;          // the second act: "Seen it" — a write with no external calls

const CONTENDERS = [
  { key: "playwright", mod: await import("./contenders/playwright.mjs") },
  { key: "cdp", mod: await import("./contenders/cdp.mjs") },
];

// --tmdb is required: /media/<id> fetches TMDB detail, and without a key it answers 401 → 500, so
// the sheet never opens. Same fixture, same read-only metadata call as run-live.
const fixture = await startHubFixture({ tmdb: true });
const cookie = fixture.cookie;

/** Open tile `tileIndex`'s sheet through htmx, then hand back the target the arms act on. */
async function openSheet(session, tileIndex) {
  await session.goto(`${fixture.origin}/recommend`, probes.READY_TILES, 30000);
  const box = await session.eval(`(() => { const a = document.querySelectorAll('.rec-tile .rec-open')[${tileIndex}];
    if (!a) return null;
    const b = a.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 60) }; })()`);
  if (!box) throw new Error(`no tile ${tileIndex} to open`);
  await session.clickAt(box.x, box.y);
  await session.waitFor(probes.READY_SHEET, 30000);
  await sleep(SHEET_SETTLE_MS);
  return session.eval(`(() => {
    const b = document.querySelectorAll('.detail-rec .act')[${ACTION_INDEX}];
    const f = b && b.closest('form');
    if (!b || !f) return null;
    const r = b.getBoundingClientRect();
    return {
      ck: (f.querySelector('input[name="ck"]') || {}).value || null,
      label: b.textContent.trim(),
      method: (f.getAttribute('hx-post') ? 'POST' : (f.getAttribute('method') || 'GET')).toUpperCase(),
      url: f.getAttribute('hx-post') || f.getAttribute('action'),
      pressed: b.getAttribute('aria-pressed'),
      x: r.x + r.width / 2, y: r.y + r.height / 2,
    };
  })()`);
}

async function actState(session) {
  return session.eval(`(() => { const b = document.querySelectorAll('.detail-rec .act')[${ACTION_INDEX}];
    return b ? { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'),
                 on: b.classList.contains('on') } : null; })()`);
}

async function runArm(mod, arm, tileIndex) {
  const session = await mod.create({ viewport: DESKTOP, touch: false, cookie });
  const t0 = performance.now();
  try {
    // Read the target once to learn its ck, clear that title's feedback, then reopen so every
    // arm starts from the same empty slate and the button renders from a clean state.
    const peek = await openSheet(session, tileIndex);
    if (!peek) throw new Error("no action button in the opened sheet");
    if (peek.ck) clearFeedback(peek.ck);
    const target = await openSheet(session, tileIndex);
    if (!target) throw new Error("no action button on the reopened sheet");

    let refusal = null;
    if (arm === "network-guard") {
      await session.guardNetwork(({ method }) => (method === "GET" ? "allow" : "abort"));
    } else if (arm === "action-allowlist") {
      // The allowlist itself: no non-GET leaves this runner. Decided before any input is sent.
      refusal = target.method === "GET" ? null : { reason: "not on the allowlist", ...target };
    }

    const logFrom = accessLogSize();
    const dbFrom = feedbackRows();

    if (!refusal) await session.clickAt(target.x, target.y);
    await sleep(SETTLE_MS);

    const log = accessSince(logFrom);
    const posts = log.lines.filter((l) => /"POST \/recommend\/action/.test(l));
    const after = await actState(session);
    const dbTo = feedbackRows();
    return {
      arm, target, refusal, posts: posts.length, postLines: posts,
      allLines: log.lines.length, dbFrom, dbTo, dbDelta: dbTo - dbFrom,
      blockedByTool: (session.blocked || []).map((b) => `${b.method} ${b.url}`),
      act: after, ms: round(performance.now() - t0, 2),
    };
  } finally {
    await session.close();
  }
}

const raw = { generatedAt: new Date().toISOString(), fixture: fixture.origin, arms: [], contenders: [] };
const rows = [], failures = [];
// Every arm acts on tile 0 and clears that title's feedback first, so `rec_feedback`'s upsert
// cannot make a real write look like no change.
const TILE = 0;

try {
  for (const { key, mod } of CONTENDERS) {
    if (only && only !== key) continue;
    raw.contenders.push({ name: mod.name, version: mod.version });
    for (const arm of ["unguarded", "network-guard", "action-allowlist"]) {
      const run = await runArm(mod, arm, TILE);
      raw.arms.push({ contender: mod.name, ...run });
      const evidence = run.blockedByTool.length
        ? `${run.blockedByTool.length} aborted`
        : run.refusal ? `refused: ${run.refusal.method} ${run.refusal.url}` : "none";
      rows.push([
        mod.name, arm, run.posts, `${run.dbFrom}→${run.dbTo} (${run.dbDelta >= 0 ? "+" : ""}${run.dbDelta})`,
        run.act ? `${run.act.label}${run.act.on ? " (on)" : ""}` : "—", evidence,
      ]);

      const label = `${mod.name}/${arm}`;
      if (arm === "unguarded") {
        if (run.posts !== 1) failures.push(`${label}: ${run.posts} POSTs logged, expected 1`);
        if (run.dbDelta !== 1) failures.push(`${label}: rec_feedback moved ${run.dbDelta}, expected +1`);
      } else {
        if (run.posts !== 0) failures.push(`${label}: the POST still left the runner (${run.posts} logged)`);
        if (run.dbDelta !== 0) failures.push(`${label}: rec_feedback moved ${run.dbDelta}, expected 0`);
      }
    }
  }
} finally {
  fixture.stop();
}

await ensureDir(ARTIFACTS);
writeFileSync(outFile, JSON.stringify(raw, null, 2));

const totals = summarise(raw.arms.filter((a) => a.arm === "unguarded").map((a) => a.ms));
console.log(`hub fixture ${fixture.origin} (${fixture.scratch})`);
console.log(table(
  ["contender", "arm", "POSTs logged", "rec_feedback rows", "button after", "guard evidence"],
  rows,
));
console.log(`\nunguarded arm ${totals.median}ms median end-to-end; artifact ${outFile}`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} assertion(s):`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log("PASS — unguarded writes land (log + DB); both guards stop the same write with the log and DB unchanged");
}
