#!/usr/bin/env node
// RQ1's T1 (layout) and T2 (hover/timing) plus RQ2 (hover and pointer reality), on the static
// fixture. Every contender runs the same tasks, the same reads and the same repeat count.
//
//   node plugins/ui-probe/bakeoff/web/run-all.mjs
//   node plugins/ui-probe/bakeoff/web/run-all.mjs --dir <fixture-dir>   # the RED run: pre-fix CSS
//   node plugins/ui-probe/bakeoff/web/run-all.mjs --only playwright --repeats 1
//
// Exits non-zero when any T1 row disagrees with the fixture's known values.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ARTIFACTS, DESKTOP, PHONE, REPEATS, assertDesktop, assertPhone, ensureDir, meter, round,
  startStaticServer, summarise, table, timeIt,
} from "./lib/harness.mjs";
import * as probes from "./lib/probes.mjs";

const CONTENDERS = [
  { key: "playwright", mod: await import("./contenders/playwright.mjs") },
  { key: "cdp", mod: await import("./contenders/cdp.mjs") },
];

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = flag("only");
const repeats = Number(flag("repeats", REPEATS));
const fixtureDir = flag("dir");
const outFile = join(ARTIFACTS, fixtureDir ? "run-all-red.json" : "run-all.json");

const server = await startStaticServer(fixtureDir ? resolve(fixtureDir) : undefined);

/** One T1 journey: land on the sheet, then read every box the fixture is judged on. */
async function t1(session, url, viewport) {
  const steps = [];
  let obsBytes = 0;
  const gotoMs = await session.goto(url, probes.READY_SHEET);
  const layout = await session.eval(probes.READ_LAYOUT);
  const env = await session.eval(probes.READ_ENV);
  const obs = await session.observe();
  obsBytes += meter(obs).bytes;
  steps.push({ step: "goto+sheet", ms: gotoMs, observeBytes: meter(obs).bytes, observeChars: obs.length });
  return { layout, env, steps, observeBytes: obsBytes, observation: obs, viewport: viewport.name };
}

/** One T2 journey. `touch` decides which input path runs — the point of RQ2. */
async function t2(session, url, viewport) {
  const t0 = performance.now();
  const steps = [];
  await session.goto(url, probes.READY_TILES);
  const before = await session.eval(probes.READ_HOVER);
  const env = await session.eval(probes.READ_ENV);
  const box = await session.eval(`(() => { const t = document.querySelectorAll('.rec-tile')[0];
    const b = t.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

  let after;
  if (viewport.touch) {
    // A tap must never reveal the mouse-only bar. The static fixture has no htmx, so the anchor
    // would navigate; the capture listener below is applied in both contenders and only stops
    // the navigation, not the pointer events being measured.
    await session.eval(`document.addEventListener('click', (e) => e.preventDefault(), true)`);
    await session.tapAt(cx, cy);
    await new Promise((r) => setTimeout(r, 120));
    after = await session.eval(probes.READ_HOVER);
  } else {
    await session.mouseTo(cx, cy);
    await new Promise((r) => setTimeout(r, 60));
    after = await session.eval(probes.READ_HOVER);
  }
  const anim = await session.eval(probes.READ_ANIM);
  const obs = await session.observe();
  steps.push({ step: viewport.touch ? "tap" : "mouse-to-tile", ms: round(performance.now() - t0, 2) });
  return {
    before, after, env, anim, viewport: viewport.name,
    revealed: after && after.display !== "none" && after.mouseOver === true,
    observeBytes: meter(obs).bytes,
    observation: obs,
    steps,
  };
}

const rows = [];
const failures = [];
const raw = { generatedAt: new Date().toISOString(), fixture: server.origin, repeats, contenders: [], t1: [], t2: [] };

for (const { key, mod } of CONTENDERS) {
  if (only && only !== key) continue;
  raw.contenders.push({ name: mod.name, version: mod.version, install: mod.install });

  for (const viewport of [PHONE, DESKTOP]) {
    const url = `${server.origin}/detail-sheet.html`;
    const created = await timeIt(() => mod.create({ viewport, touch: viewport.touch }));
    const session = created.value;
    const runs = [];
    try {
      for (let i = 0; i < repeats; i++) {
        const { value, ms } = await timeIt(() => t1(session, url, viewport));
        runs.push({ ...value, totalMs: ms });
      }
    } finally {
      await session.close();
    }
    const first = runs[0];
    const warm = summarise(runs.slice(1).map((r) => r.totalMs));
    raw.t1.push({ contender: mod.name, viewport: viewport.name, launchMs: created.ms, runs });
    rows.push([
      mod.name, viewport.name, `${round(created.ms)} / ${warm.median ?? "—"}`,
      first.layout.acts.map((a) => a.w).join("/"),
      first.layout.close ? `${first.layout.close.x},${first.layout.close.y}` : "—",
      first.layout.top ? first.layout.top.h : "—",
      first.layout.foot.length,
      `${first.observeBytes}B`,
    ]);
    const label = `${mod.name}/${viewport.name}`;
    const problems = viewport.touch ? assertPhone(first.layout, label) : assertDesktop(first.layout, label);
    failures.push(...problems);
  }

  for (const viewport of [DESKTOP, PHONE]) {
    const url = `${server.origin}/detail-sheet-tiles.html`;
    const session = await mod.create({ viewport, touch: viewport.touch });
    try {
      const run = await t2(session, url, viewport);
      raw.t2.push({ contender: mod.name, ...run });
      const label = `${mod.name}/${viewport.name}/T2`;
      if (viewport.touch) {
        if (run.revealed) failures.push(`${label}: a tap revealed the mouse-only hover bar`);
        if (run.after.mouseOver) failures.push(`${label}: a tap set .mouse-over (pointerType was not touch)`);
      } else {
        if (!run.revealed) failures.push(`${label}: a real mouse move did not reveal the hover bar (${JSON.stringify(run.after)})`);
        if (run.after.display !== "flex") failures.push(`${label}: hover bar display is ${run.after.display}, expected flex`);
        if (run.after.buttonVisible !== 3) failures.push(`${label}: ${run.after.buttonVisible} of 3 hover buttons visible`);
      }
      rows.push([
        `${mod.name} T2`, viewport.name, "—", `hover=${run.after.pointer.hover} fine=${run.after.pointer.fine}`,
        `display=${run.after.display}`, `mouse-over=${run.after.mouseOver}`, `${run.after.buttonVisible}/3`, `${run.observeBytes}B`,
      ]);
    } finally {
      await session.close();
    }
  }
}

await server.close();
await ensureDir(ARTIFACTS);
writeFileSync(outFile, JSON.stringify(raw, null, 2));

console.log(table(
  ["contender", "viewport", "launch/warm ms", "tile widths", "close x,y", "top band", "footer", "observe"],
  rows,
));

console.log("\nRQ2 — what each tool's environment claims and does");
console.log(table(
  ["contender", "viewport", "hover:hover", "pointer:fine", "maxTouchPoints", "bar after input"],
  raw.t2.map((r) => [
    r.contender, r.viewport,
    String(r.env.hover_hover), String(r.env.pointer_fine), r.env.maxTouchPoints,
    r.viewport.startsWith("390") ? `tap -> ${r.after.display}` : `mouse -> ${r.after.display}`,
  ]),
));

console.log(`\n${repeats} repeat(s) per row; artifact ${outFile}`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} assertion(s):`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log("PASS — phone tiles 111/111/111, close at x 336, 17 px top band, desktop pills on one row; mouse reveals the bar and touch does not");
}
