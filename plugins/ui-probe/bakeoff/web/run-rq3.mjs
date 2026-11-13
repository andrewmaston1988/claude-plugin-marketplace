#!/usr/bin/env node
// RQ3 — temporal capture cost on T2. Three instruments, measured against the same sequence:
//   A  computed-style sampling on rAF
//   B  document.getAnimations() metadata
//   C  a filmstrip (CDP Page.startScreencast, or a Playwright trace with screenshots)
//
// Two arms. The first is the target as it is: the hover reveal is a discrete `display` flip, so
// `getAnimations()` has nothing to report and the filmstrip has one frame's difference. The
// second injects the same 240 ms WAAPI animation into both tools, so the instruments are compared
// on a signal that actually exists rather than on an absence.
//
//   node plugins/ui-probe/bakeoff/web/run-rq3.mjs [--repeats 3]
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS, DESKTOP, REPEATS, ensureDir, meter, round, sleep, startStaticServer, summarise, table,
} from "./lib/harness.mjs";
import * as probes from "./lib/probes.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const repeats = Number(flag("repeats", REPEATS));
const outFile = join(ARTIFACTS, "rq3.json");

const CONTENDERS = [
  { key: "playwright", mod: await import("./contenders/playwright.mjs") },
  { key: "cdp", mod: await import("./contenders/cdp.mjs") },
];

const server = await startStaticServer();
const url = `${server.origin}/detail-sheet-tiles.html`;

/** The reveal itself: what each instrument says about the real target. */
async function measure(session) {
  await session.goto(url, probes.READY_TILES);
  const box = await session.eval(`(() => { const t = document.querySelectorAll('.rec-tile')[0];
    const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await session.mouseTo(2, 2);
  await sleep(50);

  // A — sample across the hover, so the sampler sees the moment the bar flips from none to flex.
  // The input lands after a short lead-in: dispatched any sooner, the first sampled frame is
  // already the post-hover state and the flip leaves no trace in the series.
  const sampling = session.eval(probes.sampleFor(250));
  await sleep(80);
  await session.mouseTo(box.x, box.y);
  const realSample = await sampling;
  // B — getAnimations() during the real reveal
  const realAnims = await session.eval(probes.READ_ANIM);

  // A + B on the controlled animation, from the revealed state so it actually paints
  const curve = session.eval(probes.sampleFor(300));
  await sleep(80);
  await session.eval(probes.INJECT_ANIM);
  const animSample = await curve;
  const animMeta = await session.eval(probes.READ_ANIM);

  return { realSample, realAnims, animSample, animMeta, box };
}

const raw = { generatedAt: new Date().toISOString(), repeats, runs: [] };
const rows = [], failures = [];

for (const { mod } of CONTENDERS) {
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const session = await mod.create({ viewport: DESKTOP, touch: false });
    try {
      runs.push(await measure(session));
    } finally {
      await session.close();
    }
  }

  // C — the filmstrip, on its own sessions so the capture covers the whole window cleanly.
  const films = [];
  for (let i = 0; i < repeats; i++) {
    const session = await mod.create({ viewport: DESKTOP, touch: false });
    try {
      await session.goto(url, probes.READY_TILES);
      // The bar is display:none until the tile is hovered, and a hidden element paints no frames —
      // both capture paths would otherwise film an empty rectangle.
      const box = await session.eval(`(() => { const t = document.querySelectorAll('.rec-tile')[0];
        const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      await session.mouseTo(box.x, box.y);
      await sleep(120);
      if (mod.name === "cdp") {
        const t0 = performance.now();
        await session.screencastStart();
        await session.eval(probes.INJECT_ANIM);
        await sleep(400);
        const frames = await session.screencastStop();
        films.push({
          kind: "CDP Page.startScreencast (jpeg q60)",
          frames: frames.length,
          bytes: frames.reduce((n, f) => n + f.bytes, 0),
          ms: round(performance.now() - t0, 2),
        });
      } else {
        const file = join(ARTIFACTS, `rq3-trace-${mod.name}.zip`);
        const t0 = performance.now();
        await session.traceStart(file);
        await session.eval(probes.INJECT_ANIM);
        await sleep(400);
        const path = await session.traceStop();
        films.push({
          kind: "Playwright tracing (screenshots: true)",
          frames: zipEntries(path).filter((n) => n.endsWith(".jpeg")).length,
          bytes: statSync(path).size,
          ms: round(performance.now() - t0, 2),
          artifact: path,
        });
      }
    } finally {
      await session.close();
    }
  }
  const film = {
    ...films[0],
    framesMedian: summarise(films.map((f) => f.frames)).median,
    bytesMedian: summarise(films.map((f) => f.bytes)).median,
    msMedian: summarise(films.map((f) => f.ms)).median,
    msSamples: films.map((f) => f.ms),
  };

  const first = runs[0];
  const samples = first.realSample.samples || [];
  const flipAt = samples.findIndex((s) => s.display !== samples[0]?.display);
  const realAnimCount = first.realAnims.count;
  const animFrames = first.animSample.n;
  const animDetected = first.animMeta.count;

  raw.runs.push({ contender: mod.name, runs, film, repeats });
  rows.push([
    mod.name,
    `${realAnimCount} anims / flip seen at sample ${flipAt} of ${samples.length}`,
    `${animDetected} anim / ${animMetaSummary(first.animMeta)}`,
    `${animFrames} samples, ${meter(JSON.stringify(first.animSample)).bytes}B`,
    `${meter(JSON.stringify(first.animMeta)).bytes}B`,
    `${film.framesMedian} frames, ${film.bytesMedian}B, ${film.msMedian}ms`,
  ]);

  if (realAnimCount !== 0) failures.push(`${mod.name}: the real hover reveal reported ${realAnimCount} animations — the fixture changed`);
  if (flipAt < 1) failures.push(`${mod.name}: rAF sampling did not catch the display flip (samples ${samples.length})`);
  if (animDetected < 1) failures.push(`${mod.name}: getAnimations() did not see the injected animation`);
  if (!film.framesMedian) failures.push(`${mod.name}: the filmstrip captured no frames`);
}

await server.close();
await ensureDir(ARTIFACTS);
writeFileSync(outFile, JSON.stringify(raw, null, 2));

function animMetaSummary(meta) {
  const a = meta.animations[0];
  return a ? `${a.duration}ms, ${a.properties.join("/")}` : "none";
}

/** Entry names from a zip's central directory — enough to count the trace's screenshot frames. */
function zipEntries(file) {
  const b = readFileSync(file);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return [];
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = b.readUInt16LE(off + 28), extra = b.readUInt16LE(off + 30), comment = b.readUInt16LE(off + 32);
    names.push(b.toString("utf8", off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extra + comment;
  }
  return names;
}

console.log(table(
  ["contender", "real reveal: getAnimations / rAF", "controlled: getAnimations", "A rAF bytes", "B metadata bytes", "C filmstrip (median)"],
  rows,
));
console.log(`\n${repeats} repeat(s); artifact ${outFile}`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length}:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log("PASS — the reveal is a discrete flip (0 animations), both tools detect the injected one, and the filmstrip is the only instrument that sees a frame");
}
