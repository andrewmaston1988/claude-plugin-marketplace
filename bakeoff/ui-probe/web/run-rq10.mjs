#!/usr/bin/env node
// RQ10 (size half) — what an agent actually has to read, per step, under two observation arms.
//
//   full    the whole page, as the tool's own observation gives it (aria snapshot / full AX tree)
//   delta   only the subtree the app just swapped (aria snapshot of a selector / partial AX tree)
//
// Three journeys of seven steps each, on the live hub fixture. The third is the one that matters:
// a runner-side POST flips a tile badge OUTSIDE the open sheet's subtree. The delta arm, watching
// only the sheet, reports no change; the full arm sees it. That is the cost the delta arm hides.
//
// The model-answer half is not run here. Every observation text is written to
// results/artifacts/rq10-observations.json so the session can ask a model the same questions of
// each arm and compare accuracy against size.
//
//   node bakeoff/ui-probe/web/run-rq10.mjs [--only cdp]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS, DESKTOP, SHEET_SETTLE_MS, ensureDir, meter, round, sleep, table,
} from "./lib/harness.mjs";
import { clearFeedback, startHubFixture } from "./lib/hub.mjs";
import * as probes from "./lib/probes.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = flag("only");
const outFile = join(ARTIFACTS, "rq10.json");
const obsFile = join(ARTIFACTS, "rq10-observations.json");

const CONTENDERS = [
  { key: "playwright", mod: await import("./contenders/playwright.mjs") },
  { key: "cdp", mod: await import("./contenders/cdp.mjs") },
];

const fixture = await startHubFixture({ tmdb: true });
const cookie = fixture.cookie;

// ── page actions, shared by both contenders ─────────────────────────────────
async function boxOf(session, sel, index = 0) {
  return session.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
    if (!el) return null; const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 60) }; })()`);
}

async function clickSel(session, sel, index = 0) {
  const box = await boxOf(session, sel, index);
  if (!box) throw new Error(`no element for ${sel}[${index}]`);
  await session.clickAt(box.x, box.y);
}

async function openSheet(session, index = 0) {
  await clickSel(session, ".rec-tile .rec-open", index);
  await session.waitFor(probes.READY_SHEET, 30000);
  await sleep(SHEET_SETTLE_MS);
}

async function act(session, index) {
  await clickSel(session, ".detail-rec .act", index);
  await sleep(900);
}

async function closeSheet(session) {
  await clickSel(session, ".detail-close");
  await session.waitFor(probes.READY_SHEET_CLOSED, 10000);
  await sleep(SHEET_SETTLE_MS);
}

const load = (session) => session.goto(`${fixture.origin}/recommend`, probes.READY_TILES, 30000);

// ── the journeys ────────────────────────────────────────────────────────────
// `delta` names the subtree an app-aware observer would watch for that step. A step with no swap
// of its own still names one, because a real delta subscriber never gets a free full read.
const JOURNEYS = [
  {
    name: "J1 open and inspect",
    steps: [
      { name: "load /recommend", delta: "#rec-row-row-quiet-drama", run: load },
      { name: "read the second row", delta: "#rec-row-row-coastal" },
      { name: "open the sheet", delta: "#detail-sheet-body", run: (s) => openSheet(s) },
      { name: "read the action block", delta: "#detail-rec" },
      { name: "mark Seen it", delta: "#detail-rec", run: (s) => act(s, 1) },
      { name: "close the sheet", delta: "#rec-row-row-quiet-drama", run: closeSheet },
      { name: "read the first row again", delta: "#rec-row-row-quiet-drama" },
    ],
  },
  {
    name: "J2 action loop",
    steps: [
      { name: "load /recommend", delta: "#rec-row-row-quiet-drama", run: load },
      { name: "open the sheet", delta: "#detail-sheet-body", run: (s) => openSheet(s) },
      { name: "My list", delta: "#detail-rec", run: (s) => act(s, 0) },
      { name: "Seen it", delta: "#detail-rec", run: (s) => act(s, 1) },
      { name: "rate 4 stars", delta: "#detail-rec", run: (s) => clickSel(s, ".detail-rec .stars button", 7).then(() => sleep(900)) },
      { name: "Not for me", delta: "#detail-rec", run: (s) => act(s, 2) },
      { name: "close the sheet", delta: "#rec-row-row-quiet-drama", run: closeSheet },
      { name: "read the tile badge", delta: "#rec-card-movie_900001" },
    ],
  },
  {
    name: "J3 change outside the delta",
    steps: [
      { name: "load /recommend", delta: "#rec-row-row-quiet-drama", run: load },
      { name: "read the tile badge", delta: "#rec-card-movie_900001" },
      { name: "open the sheet", delta: "#detail-sheet-body", run: (s) => openSheet(s) },
      { name: "read the action block", delta: "#detail-rec" },
      // The app swaps #detail-rec, and its HX-Trigger rewrites the tile badge — a different
      // subtree on the page. A delta observer watching the swap target sees half the answer.
      { name: "My list", delta: "#detail-rec", run: (s) => act(s, 0) },
      { name: "re-read the swapped block", delta: "#detail-rec" },
      { name: "read the tile badge", delta: "#rec-card-movie_900001" },
      { name: "close the sheet", delta: "#rec-row-row-quiet-drama", run: closeSheet },
    ],
  },
];

// ── run ─────────────────────────────────────────────────────────────────────
const raw = { generatedAt: new Date().toISOString(), fixture: fixture.origin, journeys: [], observations: [] };
const rows = [], failures = [];

async function observeBoth(session, selector) {
  const t0 = performance.now();
  const full = await session.observe();
  const fullMs = round(performance.now() - t0, 2);
  const t1 = performance.now();
  const delta = selector ? await session.observeSelector(selector) : full;
  const deltaMs = round(performance.now() - t1, 2);
  return { full, delta, fullMs, deltaMs };
}

try {
  for (const { key, mod } of CONTENDERS) {
    if (only && only !== key) continue;
    for (const journey of JOURNEYS) {
      // Every journey starts from the same state: the tile its steps act on carries no feedback,
      // so the badge J3 measures begins empty for both contenders.
      clearFeedback("movie:900001");
      const session = await mod.create({ viewport: DESKTOP, touch: false, cookie });
      const steps = [];
      try {
        for (const step of journey.steps) {
          if (step.run) await step.run(session);
          const before = await session.eval(probes.READ_JOURNEY);
          const obs = await observeBoth(session, step.delta);
          steps.push({
            name: step.name, delta: step.delta,
            full: meter(obs.full), deltaSize: meter(obs.delta),
            fullMs: obs.fullMs, deltaMs: obs.deltaMs,
            fullText: obs.full, deltaText: obs.delta,
            state: before,
          });
        }
      } finally {
        await session.close();
      }

      const sum = (arm) => steps.reduce((n, s) => n + s[arm].bytes, 0);
      const sumTok = (arm) => steps.reduce((n, s) => n + s[arm].tokens, 0);
      raw.journeys.push({ contender: mod.name, journey: journey.name, steps });
      raw.observations.push({
        contender: mod.name, journey: journey.name,
        steps: steps.map((s) => ({
          name: s.name, delta: s.delta, fullText: s.fullText, deltaText: s.deltaText,
          full: s.full, deltaSize: s.deltaSize,
        })),
      });
      rows.push([
        mod.name, journey.name, `${sum("full")}B / ${sumTok("full")}t`,
        `${sum("deltaSize")}B / ${sumTok("deltaSize")}t`,
        `${Math.round((1 - sum("deltaSize") / sum("full")) * 100)}%`,
      ]);

      // J3's whole point: the swap the delta arm watches does not carry the tile badge change.
      if (journey.name.startsWith("J3")) {
        const badgeBefore = steps[1];
        const swapped = steps[5];
        const badgeAfter = steps[6];
        const tileBefore = badgeBefore.state.tiles.find((t) => t.ck === "movie:900001");
        const tileAfter = badgeAfter.state.tiles.find((t) => t.ck === "movie:900001");
        const badgeChanged = JSON.stringify(tileBefore) !== JSON.stringify(tileAfter);
        const deltaHasBadge = /In list/.test(swapped.deltaText);
        const fullHasBadge = /In list/.test(swapped.fullText);
        if (!badgeChanged) failures.push(`${mod.name}/J3: the action did not change the tile badge`);
        if (deltaHasBadge) failures.push(`${mod.name}/J3: the swapped subtree already carried the badge change — no blindness to show`);
        // `fullHasBadge` is recorded, not asserted: with a modal dialog open, CDP's full AX tree
        // contains only the dialog (aria-modal hides the background), while Playwright's aria
        // snapshot still lists the page behind it. That is a measured difference, not a bug.
        raw.journeys.at(-1).outsideChange = {
          tileBefore, tileAfter, badgeChanged, deltaHasBadge, fullHasBadge,
          fullBytes: swapped.full.bytes, deltaBytes: swapped.deltaSize.bytes,
        };
      }
    }
  }
} finally {
  fixture.stop();
}

await ensureDir(ARTIFACTS);
writeFileSync(outFile, JSON.stringify(raw, null, 2));
writeFileSync(obsFile, JSON.stringify(raw.observations, null, 2));

console.log(`hub fixture ${fixture.origin} (${fixture.scratch})`);
console.log(table(["contender", "journey", "full (bytes/tokens)", "delta (bytes/tokens)", "saved"], rows));
for (const j of raw.journeys.filter((x) => x.outsideChange)) {
  const o = j.outsideChange;
  console.log(`${j.contender}/J3: badge "${o.tileBefore.badge}" -> "${o.tileAfter.badge}"; `
    + `full observation carries it: ${o.fullHasBadge}; swapped subtree carries it: ${o.deltaHasBadge}`);
}
console.log(`\nartifact ${outFile}\nobservations ${obsFile}`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} assertion(s):`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log("PASS — the delta arm is smaller on every journey and blind to the change J3 puts outside its subtree");
}
