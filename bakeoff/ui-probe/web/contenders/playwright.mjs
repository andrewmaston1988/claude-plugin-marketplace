// Contender (a): the scripted Playwright library — the deterministic baseline.
//
// Loaded from the @playwright/mcp install (not a top-level dependency): the same library the MCP
// server uses, driven directly. Nothing here is Playwright-specific beyond the adapter itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSERS_PATH, PLAYWRIGHT_DIR, loadPlaywright, round, sleep } from "../lib/harness.mjs";

const EXTERNAL_BLOCK = ["*://image.tmdb.org/*", "*://cdnjs.cloudflare.com/*"];
const READY_POLL_MS = 50;

const pkg = existsSync(join(PLAYWRIGHT_DIR, "package.json"))
  ? JSON.parse(readFileSync(join(PLAYWRIGHT_DIR, "package.json"), "utf8"))
  : { version: "missing" };

export const name = "playwright";
export const version = pkg.version;
export const install = {
  kind: "npm library (no CLI, no MCP server)",
  package: "@playwright/mcp/node_modules/playwright",
  version: pkg.version,
  browsersPath: BROWSERS_PATH,
  browsers: "chromium_headless_shell only",
  dependencyCount: 2,          // playwright + playwright-core
};

export async function create({ viewport, touch = false, cookie = null }) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    hasTouch: touch,
    isMobile: touch,
    locale: "en-GB",
  });
  if (cookie) {
    await context.addCookies([{
      name: cookie.cookie_name, value: cookie.cookie_value, url: "http://127.0.0.1:8001/",
    }]);
  }
  const page = await context.newPage();
  // Both contenders block the same external hosts through the same CDP domain, so the page the
  // tasks see is identical and no run depends on the network.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBlockedURLs", { urls: EXTERNAL_BLOCK });

  const session = {
    tool: name,
    raw: { browser, context, page },
    blocked: [],
    async goto(url, ready, timeoutMs = 15000) {
      const t0 = performance.now();
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
      if (ready) await waitFor(ready, timeoutMs);
      return round(performance.now() - t0, 2);
    },
    async waitFor(expr, timeoutMs = 15000) { return waitFor(expr, timeoutMs); },
    async eval(expr) { return page.evaluate(expr); },
    async mouseTo(x, y) { await page.mouse.move(x, y, { steps: 1 }); },
    async clickAt(x, y) { await page.mouse.click(x, y); },
    async tapAt(x, y) { await page.touchscreen.tap(x, y); },
    async hoverSelector(sel) { await page.locator(sel).first().hover(); },
    async clickSelector(sel) { await page.locator(sel).first().click(); },
    // The tool's own agent-facing observation: Playwright's aria snapshot (YAML).
    async observe() { return page.locator("body").ariaSnapshot(); },
    async observeSelector(sel) { return page.locator(sel).first().ariaSnapshot(); },
    async screenshot(file) { await page.screenshot({ path: file }); },
    /**
     * RQ9's network layer, in Playwright's own idiom: `route()` aborting every non-GET.
     * Returns a list of decisions the handler made, which is what "blocked and reported" means.
     */
    async guardNetwork(decision) {
      await context.route("**/*", async (route) => {
        const req = route.request();
        const verdict = decision({ method: req.method(), url: req.url() });
        if (verdict === "abort") {
          session.blocked.push({ method: req.method(), url: req.url(), at: Date.now() });
          await route.abort("blockedbyclient");
        } else {
          await route.continue();
        }
      });
    },
    async unguardNetwork() { await context.unrouteAll({ behavior: "wait" }); },
    /** Playwright's temporal capture: a trace with screenshots is the filmstrip. */
    async traceStart(file) {
      await context.tracing.start({ screenshots: true, snapshots: false, sources: false });
      session._trace = file;
    },
    async traceStop() {
      await context.tracing.stop({ path: session._trace });
      return session._trace;
    },
    async close() {
      try { await context.unrouteAll({ behavior: "ignoreErrors" }); } catch {}
      await context.close();
      await browser.close();
    },
  };

  async function waitFor(expr, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await page.evaluate(expr)) return true; } catch {}
      await sleep(READY_POLL_MS);
    }
    throw new Error(`playwright: timed out waiting for ${expr.slice(0, 60)}`);
  }

  return session;
}
