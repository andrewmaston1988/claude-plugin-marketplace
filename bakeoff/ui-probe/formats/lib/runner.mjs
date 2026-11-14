// Executes the shared IR. Flat-YAML and Gherkin both land here, so a step means
// exactly the same thing whichever format produced it.
import { loadPlaywright } from './paths.mjs';
import { httpJson, tcpBanner, uiaText } from './probes.mjs';

const OP_TIMEOUT = 8000;

function resolveTarget(page, target) {
  const m = /^role=([a-z]+)(?:\[name=(?:"([^"]*)"|'([^']*)')\])?$/.exec(target);
  if (m) {
    const name = m[2] ?? m[3];
    return page.getByRole(m[1], name === undefined ? undefined : { name });
  }
  return page.locator(target);
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= (tolerance ?? 0);
}

// Web assertions retry until they hold or the step times out. Playwright's
// expect(locator) does this for free; the IR has to say so explicitly, or a
// transition caught mid-flight (opacity 0.14 on a 120 ms fade) reads as a failure.
async function poll(fn, timeoutMs = OP_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) throw lastErr;
    await new Promise((r) => setTimeout(r, 50));
  }
}

class Session {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.viewport = { width: 1280, height: 900, touch: false };
    this.lastUrl = null;
  }

  async setViewport(next) {
    const same = this.context
      && next.width === this.viewport.width
      && next.height === this.viewport.height
      && Boolean(next.touch) === Boolean(this.viewport.touch);
    if (same) return;
    await this.closeContext();
    this.viewport = { width: next.width, height: next.height, touch: Boolean(next.touch) };
  }

  async ensurePage(url) {
    if (this.page) return this.page;
    if (!this.browser) this.browser = await loadPlaywright().chromium.launch();
    const { width, height, touch } = this.viewport;
    this.context = await this.browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
      reducedMotion: 'no-preference',
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(OP_TIMEOUT);
    if (url) await this.page.goto(url, { waitUntil: 'load' });
    return this.page;
  }

  async closeContext() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  async reopen() {
    if (!this.lastUrl) return;
    const url = this.lastUrl;
    await this.closeContext();
    await this.ensurePage(url);
  }
}

async function execStep(step, session) {
  const op = Object.keys(step)[0];
  const a = step[op];

  switch (op) {
    case 'open': {
      session.lastUrl = a.url;
      const page = await session.ensurePage(a.url);
      if (page.url() !== a.url) await page.goto(a.url, { waitUntil: 'load' });
      return;
    }
    case 'viewport': {
      const hadPage = Boolean(session.page);
      await session.setViewport({ width: a.width, height: a.height, touch: a.touch === true });
      if (hadPage) await session.reopen();
      return;
    }
    case 'hover': {
      const page = await session.ensurePage();
      await resolveTarget(page, a.target).first().hover();
      return;
    }
    case 'tap': {
      const page = await session.ensurePage();
      await resolveTarget(page, a.target).first().tap();
      return;
    }
    case 'click': {
      const page = await session.ensurePage();
      await resolveTarget(page, a.target).first().click();
      return;
    }
    case 'expect_visible': {
      const page = await session.ensurePage();
      const loc = resolveTarget(page, a.target);
      await loc.first().waitFor({ state: 'visible', timeout: a.timeoutMs ?? OP_TIMEOUT });
      return;
    }
    case 'expect_hidden': {
      const page = await session.ensurePage();
      await resolveTarget(page, a.target).first().waitFor({ state: 'hidden', timeout: a.timeoutMs ?? OP_TIMEOUT });
      return;
    }
    case 'expect_widths': {
      const page = await session.ensurePage();
      return poll(async () => {
        const loc = resolveTarget(page, a.target);
        const count = await loc.count();
        // A single expected value applies to every matched element; a list must match 1:1.
        const uniform = a.equals.length === 1;
        if (!uniform && count !== a.equals.length) {
          throw new Error(`found ${count} element(s) for ${a.target}, expected ${a.equals.length}`);
        }
        if (count === 0) throw new Error(`found no elements for ${a.target}`);
        const widths = await loc.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
        const bad = widths
          .map((w, i) => (near(w, a.equals[uniform ? 0 : i], a.tolerance) ? null : `${i}: ${w} != ${a.equals[uniform ? 0 : i]}`))
          .filter(Boolean);
        if (bad.length) throw new Error(`widths [${widths.join(', ')}] do not match [${a.equals.join(', ')}]: ${bad.join('; ')}`);
      }, a.timeoutMs);
    }
    case 'expect_css': {
      const page = await session.ensurePage();
      return poll(async () => {
        const loc = resolveTarget(page, a.target).first();
        const actual = await loc.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), a.property);
        const expectedNum = Number(a.equals);
        const gotNum = Number(actual);
        const ok = Number.isFinite(expectedNum) && Number.isFinite(gotNum)
          ? near(gotNum, expectedNum, a.tolerance ?? 0)
          : String(actual).trim() === String(a.equals).trim();
        if (!ok) throw new Error(`${a.target} ${a.property} = ${JSON.stringify(actual)}, expected ${JSON.stringify(a.equals)}`);
      }, a.timeoutMs);
    }
    case 'expect_text': {
      const page = await session.ensurePage();
      return poll(async () => {
        const actual = (await resolveTarget(page, a.target).first().textContent()) ?? '';
        if (actual.trim() !== String(a.equals).trim()) {
          throw new Error(`${a.target} text = ${JSON.stringify(actual.trim())}, expected ${JSON.stringify(a.equals)}`);
        }
      }, a.timeoutMs);
    }
    case 'expect_json': {
      const res = await httpJson(a.url);
      if (res.status !== 200) throw new Error(`GET ${a.url} returned ${res.status}`);
      if (res.body === null) throw new Error(`GET ${a.url} did not return JSON: ${res.text.slice(0, 200)}`);
      const actual = a.path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), res.body);
      if (String(actual) !== String(a.equals)) {
        throw new Error(`${a.path} = ${JSON.stringify(actual)}, expected ${JSON.stringify(a.equals)}`);
      }
      return;
    }
    case 'tcp_banner': {
      const banner = await tcpBanner(a.host ?? '127.0.0.1', a.port);
      if (banner !== a.equals) throw new Error(`banner ${JSON.stringify(banner)}, expected ${JSON.stringify(a.equals)}`);
      return;
    }
    case 'uia_text': {
      const text = await uiaText(a.window, a.control);
      if (text !== a.equals) throw new Error(`UIA text ${JSON.stringify(text)}, expected ${JSON.stringify(a.equals)}`);
      return;
    }
    default:
      throw new Error(`unsupported op ${JSON.stringify(op)}`);
  }
}

export async function runIR(ir) {
  const started = Date.now();
  const session = new Session();
  const steps = [];
  let failure = null;
  try {
    for (const [i, step] of ir.steps.entries()) {
      const op = Object.keys(step)[0];
      try {
        await execStep(step, session);
        steps.push({ index: i, op, ok: true });
      } catch (err) {
        steps.push({ index: i, op, ok: false, error: err.message });
        failure = { index: i, op, error: err.message };
        break;
      }
    }
  } finally {
    await session.closeContext();
    if (session.browser) await session.browser.close().catch(() => {});
  }
  return { passed: !failure, failure, steps, ms: Date.now() - started };
}
