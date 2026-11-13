// RQ5 runner: PrintWindow capture of the owner-drawn fixture, then Windows.Media.Ocr.
//
//   node run-ocr.mjs [--repeats 10]
//
// Writes results/raw/rq5.json. Launches only its own fixture and kills it by PID.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PS51, runProcess } from '../windows/adapters.mjs';
import { launchFixture, killFixture, makeTmpDir, cleanTmp, percentile } from '../windows/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = path.join(HERE, 'capture.ps1');
const OCR = path.join(HERE, 'ocr-json.ps1');
const OUT_DIR = path.join(HERE, '..', 'results');
const RAW_DIR = path.join(OUT_DIR, 'raw');

export const EXPECTED = ['Alpha 17', 'Bravo 42', 'Charlie 99'];

const args = process.argv.slice(2);
const repeatsArg = args.indexOf('--repeats');
const REPEATS = repeatsArg >= 0 ? Number(args[repeatsArg + 1]) : 10;

const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Character-level edit distance, so a near miss is reported as a number not a verdict. */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function score(expected, lines) {
  const want = normalize(expected);
  let best = null;
  for (const line of lines) {
    const got = normalize(line.text);
    const distance = editDistance(want, got);
    if (!best || distance < best.distance) best = { got: line.text, distance, line };
  }
  const exact = best && best.distance === 0;
  // Substring hits still count as exposed — OCR often glues a neighbour on.
  const contained = normalize(best?.got).includes(want);
  return {
    expected,
    exact: Boolean(exact),
    contained: Boolean(contained),
    best_text: best?.got ?? null,
    edit_distance: best?.distance ?? null,
    box: best?.line ? { x: best.line.x, y: best.line.y, w: best.line.w, h: best.line.h } : null,
    words: best?.line?.words?.map((w) => w.text) ?? null,
  };
}

async function main() {
  const tmp = makeTmpDir('ocr');
  const out = {
    repeats: REPEATS,
    fixture: null,
    runs: [],
    tesseract: null,
    blender: null,
    started_at: new Date().toISOString(),
  };
  const fixture = await launchFixture('OwnerDrawn', tmp, null);
  out.fixture = { kind: fixture.kind, pid: fixture.pid, title: fixture.title };
  try {
    for (let i = 0; i < REPEATS; i += 1) {
      const png = path.join(tmp, `owner-${i}.png`);
      const capture = await runProcess(PS51, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE,
        '-Title', fixture.title, '-OutFile', png,
      ]);
      const t0 = performance.now();
      const ocr = await runProcess(PS51, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR,
        '-Path', png, '-Scale', '2',
      ]);
      const ocrWall = Math.round(performance.now() - t0);
      out.runs.push({
        i,
        capture_ok: Boolean(capture.ok),
        capture_error: capture.error ?? null,
        capture_ms: capture.capture_ms ?? null,
        capture_wall_ms: capture.__wall_ms ?? null,
        png_bytes: capture.bytes ?? null,
        size: ocr.size ?? null,
        ocr_ok: Boolean(ocr.ok),
        ocr_error: ocr.error ?? null,
        ocr_ms: ocr.ocr_ms ?? null,
        ocr_wall_ms: ocrWall,
        line_text: ocr.line_text ?? null,
        lines: ocr.lines ?? [],
        scores: EXPECTED.map((e) => score(e, ocr.lines ?? [])),
      });
      process.stderr.write(`  ocr run ${i + 1}/${REPEATS}\n`);
    }
    // Keep the last capture beside the results so the operator can eyeball it.
    const keep = path.join(OUT_DIR, 'owner-drawn-capture.png');
    fs.copyFileSync(path.join(tmp, `owner-${REPEATS - 1}.png`), keep);
    out.capture_png = keep;
  } finally {
    killFixture(fixture);
    cleanTmp(tmp);
  }

  const tesseract = spawnSync('where', ['tesseract'], { encoding: 'utf8', windowsHide: true });
  out.tesseract = tesseract.status === 0
    ? { installed: true, path: tesseract.stdout.trim().split(/\r?\n/)[0] }
    : { installed: false };

  const blender = spawnSync(PS51, ['-NoProfile', '-Command',
    "$p = Get-Process blender -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { \"$($p.Id)`t$($p.MainWindowTitle)\" }"],
  { encoding: 'utf8', windowsHide: true });
  const blenderLine = (blender.stdout || '').trim();
  if (blenderLine) {
    const [pid, ...rest] = blenderLine.split('\t');
    const png = path.join(OUT_DIR, 'blender-capture.png');
    const capture = await runProcess(PS51, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE,
      '-Title', rest.join('\t'), '-OutFile', png,
    ]);
    const ocr = capture.ok
      ? await runProcess(PS51, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR, '-Path', png, '-Scale', '1'])
      : null;
    out.blender = {
      running: true,
      pid: Number(pid),
      title: rest.join('\t'),
      capture_ok: Boolean(capture.ok),
      capture_error: capture.error ?? null,
      size: capture.width && capture.height ? `${capture.width}x${capture.height}` : null,
      png: png,
      png_bytes: capture.bytes ?? null,
      ocr_ok: ocr ? Boolean(ocr.ok) : null,
      ocr_error: ocr?.error ?? ocr?.__stderr ?? null,
      ocr_ms: ocr?.ocr_ms ?? null,
      line_count: ocr?.lines?.length ?? null,
      line_text: ocr?.line_text ?? null,
    };
  } else {
    out.blender = { running: false };
  }

  const ok = out.runs.filter((r) => r.capture_ok && r.ocr_ok);
  out.summary = {
    runs_ok: ok.length,
    runs_expected: REPEATS,
    capture_ms: percentile(ok.map((r) => r.capture_ms), 0.5),
    capture_p95: percentile(ok.map((r) => r.capture_ms), 0.95),
    ocr_ms: percentile(ok.map((r) => r.ocr_ms), 0.5),
    ocr_p95: percentile(ok.map((r) => r.ocr_ms), 0.95),
    exact: EXPECTED.map((e) => ({
      expected: e,
      hits: ok.filter((r) => r.scores.find((s) => s.expected === e)?.exact).length,
    })),
  };

  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, 'rq5.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary, null, 2));
  console.log(`wrote ${file}`);
}

await main();
