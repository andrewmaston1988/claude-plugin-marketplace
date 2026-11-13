// Shared harness for the web lane: one set of fixtures, tasks, timings, repeat counts and output
// columns, so the two contenders differ only in the tool driving the browser.
//
// A contender is a thin adapter (see ./contenders/) exposing:
//   { name, version, install, async create({ url, viewport, touch }) -> Session }
// and a Session exposing:
//   goto(url, readyExpr)  eval(expr)  mouseTo(x,y)  clickAt(x,y)  tapAt(x,y)
//   observe()             screenshot(file)         close()
//
// Nothing in this file knows which tool is running.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WEB_DIR = resolve(HERE, "..");
export const BAKEOFF_DIR = resolve(WEB_DIR, "..");
export const FIXTURE_DIR = join(BAKEOFF_DIR, "fixtures", "static");
export const ARTIFACTS = join(BAKEOFF_DIR, "results", "artifacts");

// The browsers live where the plan puts them. Set explicitly in every process that launches one:
// the install path and the run path must hold the same value or Playwright dies with
// "Executable doesn't exist".
export const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  || join(process.env.LOCALAPPDATA || "", "ui-probe", "ms-playwright");
// Playwright reads this at require time, not at launch, so it must be set before any adapter
// loads the library. Doing it here means every script in the lane gets it from one place.
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;

// Playwright is not a top-level package: it is the library inside @playwright/mcp. Absolute-path
// require, because the package's `exports` map blocks the deep bare specifier.
const NPM_ROOT = process.env.npm_config_prefix
  ? join(process.env.npm_config_prefix, "node_modules")
  : join(process.env.APPDATA || "", "npm", "node_modules");
export const PLAYWRIGHT_DIR = join(NPM_ROOT, "@playwright", "mcp", "node_modules", "playwright");

export function loadPlaywright() {
  if (!existsSync(PLAYWRIGHT_DIR)) throw new Error(`playwright not found at ${PLAYWRIGHT_DIR}`);
  const req = createRequire(join(PLAYWRIGHT_DIR, "package.json"));
  return req(PLAYWRIGHT_DIR);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

export function bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

// One fixed tokenizer estimate for every arm, per the plan. Never a model call.
export function tokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

export function meter(text) {
  const s = String(text ?? "");
  return { bytes: bytes(s), chars: s.length, tokens: tokens(s) };
}

export async function timeIt(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - t0, 2) };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Serve the static fixture directory. Same origin and same bytes for both contenders. */
export async function startStaticServer(root = FIXTURE_DIR) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const target = resolve(base, "." + (path === "/" ? "/detail-sheet.html" : path));
    if (!(target === base || target.startsWith(base + sep))) {
      res.writeHead(403).end("outside the fixture");
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(target)] || "application/octet-stream" });
    createReadStream(target).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** The hub fixture's session file, written by fixtures/hub_fixture.py. */
export const HUB_SCRATCH = process.env.UI_PROBE_HUB_SCRATCH
  || join(process.env.LOCALAPPDATA || "", "ui-probe", "hub-fixture");
export const HUB_ORIGIN = "http://127.0.0.1:8001";

export async function hubSession() {
  const file = join(HUB_SCRATCH, "session.json");
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw);          // {cookie_name, cookie_value, profile_id, engine_key}
}

// ── the tasks ───────────────────────────────────────────────────────────────
// Two viewports, fixed. T1 at both; T2 desktop + touch. Same for every contender.
export const PHONE = { name: "390x844", width: 390, height: 844, touch: true };
export const DESKTOP = { name: "1280x900", width: 1280, height: 900, touch: false };

export const REPEATS = Number(process.env.UI_PROBE_REPEATS || 3);

// The bottom sheet slides in. Boxes read the instant the markup lands can still be mid-animation,
// and a click there hits the backdrop instead of the control — so every runner that clicks inside
// the sheet waits this long after the sheet is ready. Same constant for every contender.
export const SHEET_SETTLE_MS = 250;

// Reference values for T1 on the phone, from the test plan. The sheet is 390 wide, its grid
// padding 20 px a side and the gap 8 px, so three tiles are (390-40-16)/3 = 111.33 px.
export const PHONE_REFERENCE = {
  tileWidths: [111, 111, 111],
  closeX: 336,          // 390 - 10 (right) - 44 (button)
  topBand: 17,
  tolerancePx: 1,
};

export function assertPhone(m, label) {
  const problems = [];
  const tol = PHONE_REFERENCE.tolerancePx;
  const widths = (m.acts || []).map((a) => a.w);
  if (widths.length !== 3) problems.push(`${label}: ${widths.length} action tiles, expected 3`);
  widths.forEach((w, i) => {
    const want = PHONE_REFERENCE.tileWidths[i];
    if (want != null && Math.abs(w - want) > tol) problems.push(`${label}: tile ${i} is ${w}px, expected ${want}px`);
  });
  if (m.close == null) problems.push(`${label}: no close button measured`);
  else if (Math.abs(m.close.x - PHONE_REFERENCE.closeX) > tol) {
    problems.push(`${label}: close button at x ${m.close.x}, expected ${PHONE_REFERENCE.closeX}`);
  }
  if (m.top == null) problems.push(`${label}: no top band measured`);
  else if (Math.abs(m.top.h - PHONE_REFERENCE.topBand) > tol) {
    problems.push(`${label}: top band ${m.top.h}px, expected ${PHONE_REFERENCE.topBand}px`);
  }
  if (!m.foot || m.foot.length < 2) problems.push(`${label}: ${m.foot ? m.foot.length : 0} footer buttons, expected 2`);
  return problems;
}

export function assertDesktop(m, label) {
  const problems = [];
  const acts = m.acts || [];
  if (acts.length !== 3) problems.push(`${label}: ${acts.length} action pills, expected 3`);
  // "pills in one row": every action shares a top edge and a height.
  const tops = new Set(acts.map((a) => Math.round(a.y)));
  if (tops.size > 1) problems.push(`${label}: action pills not on one row (tops ${[...tops].join(", ")})`);
  const heights = new Set(acts.map((a) => Math.round(a.h)));
  if (heights.size > 1) problems.push(`${label}: action pills differ in height (${[...heights].join(", ")})`);
  if (m.close == null) problems.push(`${label}: no close button measured`);
  if (!m.gridCols || !String(m.gridCols).startsWith("260")) {
    problems.push(`${label}: desktop grid columns are ${JSON.stringify(m.gridCols)}, expected to start at 260px`);
  }
  return problems;
}

// ── output ──────────────────────────────────────────────────────────────────
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function summarise(samples) {
  const xs = samples.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, min: null, median: null, max: null };
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { n: xs.length, min: round(xs[0], 2), median: round(median, 2), max: round(xs[xs.length - 1], 2) };
}

export async function ensureDir(dir) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  return dir;
}

export function footprintBytes(path) {
  let total = 0;
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else total += st.size;
  };
  try { walk(path); } catch { return null; }
  return total;
}
