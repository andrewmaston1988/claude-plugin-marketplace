#!/usr/bin/env node
// T1 and T2 against the live hub fixture on :8001 — the real page, the real htmx sheet, the real
// pointer-type reveal. Same reads, same repeats and same assertions as the static run.
//
//   node plugins/ui-probe/bakeoff/web/run-live.mjs [--repeats 3] [--only cdp]
//
// The fixture is spawned here and killed by the PID this script created; nothing else is touched.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS, DESKTOP, HUB_ORIGIN, PHONE, REPEATS,
  assertDesktop, assertPhone, ensureDir, meter, round, sleep, summarise, table,
} from "./lib/harness.mjs";
import * as probes from "./lib/probes.mjs";
import { startHubFixture } from "./lib/hub.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = flag("only");
const repeats = Number(flag("repeats", REPEATS));
const outFile = join(ARTIFACTS, "run-live.json");

const CONTENDERS = [
  { key: "playwright", mod: await import("./contenders/playwright.mjs") },
  { key: "cdp", mod: await import("./contenders/cdp.mjs") },
];

// ── fixture lifecycle ───────────────────────────────────────────────────────
const fixture = await startHubFixture({ tmdb: true });
const cookie = fixture.cookie;

// ── tasks ───────────────────────────────────────────────────────────────────
/** T1 on the live page: land on /recommend, open tile 0's sheet through htmx, then read the boxes. */
async function t1Live(session, viewport) {
  const steps = [];
  let observeBytes = 0;
  const gotoMs = await session.goto(`${HUB_ORIGIN}/recommend`, probes.READY_TILES, 30000);
  observeBytes += meter(await session.observe()).bytes;
  steps.push({ step: "goto /recommend", ms: gotoMs });

  const box = await session.eval(`(() => { const a = document.querySelectorAll('.rec-tile .rec-open')[0];
    const b = a.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const cx = box.x + box.w / 2, cy = box.y + Math.min(box.h / 2, 80);
  const tap = performance.now();
  if (viewport.touch) await session.tapAt(cx, cy); else await session.clickAt(cx, cy);
  await session.waitFor(probes.READY_SHEET, 30000);
  steps.push({ step: "open sheet", ms: round(performance.now() - tap, 2) });

  const layout = await session.eval(probes.READ_LAYOUT);
  const env = await session.eval(probes.READ_ENV);
  const obs = await session.observe();
  observeBytes += meter(obs).bytes;
  steps.push({ step: "measure", ms: 0, observeBytes: meter(obs).bytes });
  return { layout, env, steps, observeBytes, observation: obs };
}

/** T2 on the live page. Touch taps the tile for real: the sheet must open, the bar must not. */
async function t2Live(session, viewport) {
  await session.goto(`${HUB_ORIGIN}/recommend`, probes.READY_TILES, 30000);
  const box = await session.eval(`(() => { const t = document.querySelectorAll('.rec-tile')[0];
    const b = t.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const cx = box.x + box.w / 2, cy = box.y + Math.min(box.h / 2, 80);
  if (viewport.touch) {
    await session.tapAt(cx, cy);
    await sleep(700);
  } else {
    await session.mouseTo(cx, cy);
    await sleep(150);
  }
  const after = await session.eval(probes.READ_HOVER);
  const sheetOpen = await session.eval(`!!document.querySelector('#detail-sheet[open]')`);
  const env = await session.eval(probes.READ_ENV);
  return { after, sheetOpen, env, reveal: after.display !== "none" && after.mouseOver, observeBytes: meter(await session.observe()).bytes };
}

// ── run ─────────────────────────────────────────────────────────────────────
const raw = { generatedAt: new Date().toISOString(), fixture: HUB_ORIGIN, repeats, t1: [], t2: [], contenders: [] };
const rows = [], t2rows = [], failures = [];

try {
  for (const { key, mod } of CONTENDERS) {
    if (only && only !== key) continue;
    raw.contenders.push({ name: mod.name, version: mod.version, install: mod.install });

    for (const viewport of [PHONE, DESKTOP]) {
      const session = await mod.create({ viewport, touch: viewport.touch, cookie });
      const runs = [];
      const launches = [];
      try {
        for (let i = 0; i < repeats; i++) {
          const t0 = performance.now();
          runs.push(await t1Live(session, viewport));
          launches.push(round(performance.now() - t0, 2));
        }
      } finally {
        await session.close();
      }
      const first = runs[0];
      const warm = summarise(launches.slice(1));
      raw.t1.push({ contender: mod.name, viewport: viewport.name, runs, totalMs: launches });
      rows.push([
        mod.name, viewport.name, warm.median ?? "—",
        first.layout.acts.map((a) => a.w).join("/"),
        first.layout.close ? `${first.layout.close.x},${first.layout.close.y}` : "—",
        first.layout.top ? first.layout.top.h : "—",
        first.layout.foot.length,
        `${first.observeBytes}B`,
      ]);
      const label = `${mod.name}/${viewport.name}/live`;
      const problems = viewport.touch ? assertPhone(first.layout, label) : assertDesktop(first.layout, label);
      failures.push(...problems);
    }

    for (const viewport of [DESKTOP, PHONE]) {
      const session = await mod.create({ viewport, touch: viewport.touch, cookie });
      try {
        const run = await t2Live(session, viewport);
        raw.t2.push({ contender: mod.name, viewport: viewport.name, ...run });
        t2rows.push([
          mod.name, viewport.name,
          String(run.env.hover_hover), String(run.env.pointer_fine), String(run.env.maxTouchPoints),
          viewport.touch ? `tap -> ${run.after.display}` : `mouse -> ${run.after.display}`,
          `mouse-over=${run.after.mouseOver}`, `sheet=${run.sheetOpen}`,
        ]);
        const label = `${mod.name}/${viewport.name}/live/T2`;
        if (viewport.touch) {
          if (run.reveal) failures.push(`${label}: a tap revealed the mouse-only hover bar`);
          if (!run.sheetOpen) failures.push(`${label}: a tap did not open the detail sheet`);
        } else if (!run.reveal) {
          failures.push(`${label}: a real mouse move did not reveal the hover bar`);
        }
      } finally {
        await session.close();
      }
    }
  }
} finally {
  fixture.stop();
}

await ensureDir(ARTIFACTS);
writeFileSync(outFile, JSON.stringify(raw, null, 2));

console.log(`hub fixture ${HUB_ORIGIN} (${fixture.scratch})`);
console.log(table(
  ["contender", "viewport", "warm ms", "tile widths", "close x,y", "top band", "footer", "observe"],
  rows,
));
console.log("\nRQ2 on the live page");
console.log(table(
  ["contender", "viewport", "hover:hover", "pointer:fine", "touchPoints", "bar after input", "class", "sheet"],
  t2rows,
));
console.log(`\n${repeats} repeat(s); artifact ${outFile}`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} assertion(s):`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log("PASS — the live sheet measures the same as the static one, and pointer type still gates the bar");
}
