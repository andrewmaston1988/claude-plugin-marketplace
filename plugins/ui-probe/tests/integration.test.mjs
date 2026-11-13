// Integration rows: a real browser against a node:http fixture on an ephemeral port.
// With no Chromium browser the browser rows skip (printing why); UI_PROBE_REQUIRE_BROWSER=1
// turns that skip into a failure, so CI cannot go green with every browser row unexercised.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { startFixtureServer, AUTH_COOKIE } from "./fixtures/server.mjs";
import { BUILTIN_VIEWPORTS } from "../src/config.mjs";
import { findBrowser, launch } from "../src/browser.mjs";
import { connect } from "../src/cdp.mjs";
import { observe } from "../src/observe.mjs";
import { run } from "../src/runner.mjs";
import { capture } from "../src/capture.mjs";
import { dispatchKey } from "../src/tv/keys.mjs";

const REQUIRED = process.env.UI_PROBE_REQUIRE_BROWSER === "1";
const OVERRIDE = process.env.UI_PROBE_BROWSER || undefined;
const IS_CHILD = process.env.UI_PROBE_CHILD === "1";

let browserPath = null;
let browserProblem = null;
try {
  browserPath = findBrowser({ browser: OVERRIDE });
} catch (error) {
  browserProblem = error.message;
}

const SKIP = browserPath ? false : `${browserProblem} (set UI_PROBE_REQUIRE_BROWSER=1 to fail instead of skip)`;
if (!browserPath) console.log(`integration: no browser — ${browserProblem}`);

let server;
let browser;
let client;
let outRoot;
let dirCount = 0;

const outDir = (name) => join(outRoot, `${String(++dirCount).padStart(2, "0")}-${name}`);
const config = (extra = {}) => ({ baseUrl: server.origin, viewports: { ...BUILTIN_VIEWPORTS }, ...extra });

function runOn(steps, ctx = {}) {
  return run({ id: "it", steps }, { cdp: client, baseUrl: server.origin, ...ctx });
}

const steps = (path, ...rest) => [{ open: { url: path } }, ...rest];

// A TV journey on the desktop device: 1920x1080, dpr 1, no touch, the same key dispatch.
const runTv = (journey, ctx = {}) => run({ id: "tv", backend: "tv", steps: journey }, {
  cdp: client, baseUrl: server.origin, ...ctx,
});

function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// A nested `node --test` is refused while NODE_TEST_CONTEXT is inherited from this runner.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const BIN = fileURLToPath(new URL("../bin/ui-probe.mjs", import.meta.url));
const execFile = promisify(execFileCallback);

// Async spawn only: the fixture server lives in this process's event loop, so a blocking child
// would starve every request the CLI makes.
async function probeCli(args, cwd) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [BIN, ...args], {
      cwd, env: childEnv({}), encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (e) {
    if (typeof e.code !== "number") throw e;
    return { status: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

before(async () => {
  server = await startFixtureServer();
  outRoot = mkdtempSync(join(tmpdir(), "ui-probe-integration-"));
  if (browserPath) {
    browser = await launch({ browser: browserPath });
    client = await connect(browser.port);
  }
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
});

if (!browserPath && REQUIRED) {
  test("a Chromium browser is required but was not found", () => {
    assert.fail(`UI_PROBE_REQUIRE_BROWSER=1 and ${browserProblem}`);
  });
}

test("row 16: expect_json passes on the right value, fails with measured on a wrong one, and is inconclusive on a 500", async () => {
  const right = await run({ id: "json", backend: "http", steps: [{ expect_json: { url: "/json/data", path: "nested.value", equals: 5 } }] }, { baseUrl: server.origin });
  assert.equal(right.outcome, "passed");
  assert.equal(right.steps[0].measured, 5);

  const wrong = await run({ id: "json", backend: "http", steps: [{ expect_json: { url: "/json/data", path: "nested.value", equals: 6 } }] }, { baseUrl: server.origin });
  assert.equal(wrong.outcome, "failed");
  assert.equal(wrong.steps[0].measured, 5);

  const error = await run({ id: "json", backend: "http", steps: [{ expect_json: { url: "/json/error", path: "ok", equals: true } }] }, { baseUrl: server.origin });
  assert.equal(error.outcome, "inconclusive");
  assert.equal(error.exitCode, 2);
});

test("row 9: expect_widths accepts 111px in both forms and fails 54/55/78 with measured", { skip: SKIP }, async () => {
  for (const equals of [[111, 111, 111], 111]) {
    const good = await runOn(steps("/tiles-good.html", { expect_widths: { target: "[data-testid=action-tile]", equals } }));
    assert.equal(good.outcome, "passed", JSON.stringify(equals));
  }
  for (const equals of [[111, 111, 111], 111]) {
    const bad = await runOn(steps("/tiles-bad.html", { expect_widths: { target: "[data-testid=action-tile]", equals, timeoutMs: 0 } }));
    assert.equal(bad.outcome, "failed", JSON.stringify(equals));
    assert.deepEqual(bad.steps[1].measured, [54, 55, 78]);
  }
});

test("row 10: expect_css over samples frames and catches a flip 150ms after hover; one sample misses it", { skip: SKIP }, async () => {
  const over = await runOn([
    { open: { url: "/hover-flip.html" } },
    { hover: { target: "#tile" } },
    { expect_css: { target: "#bar", property: "display", equals: "flex", over: 400 } },
  ]);
  assert.equal(over.outcome, "passed");
  assert.equal(over.steps[2].measured, "flex");
  assert.ok(Number.isInteger(over.steps[2].frame.index) && over.steps[2].frame.index >= 1, JSON.stringify(over.steps[2].frame));
  assert.ok(over.steps[2].frame.ms >= 100, JSON.stringify(over.steps[2].frame));

  const one = await runOn([
    { open: { url: "/hover-flip.html" } },
    { hover: { target: "#tile" } },
    { expect_css: { target: "#bar", property: "display", equals: "flex", timeoutMs: 0 } },
  ]);
  assert.equal(one.outcome, "failed");
  assert.equal(one.steps[2].measured, "none");

  const never = await runOn([
    { open: { url: "/tiles-good.html" } },
    { expect_css: { target: ".tile", property: "display", equals: "none", over: 200 } },
  ]);
  assert.equal(never.outcome, "failed");
  assert.ok(Number.isInteger(never.steps[1].frame.frames) && never.steps[1].frame.frames >= 2, JSON.stringify(never.steps[1].frame));
  assert.equal("ms" in never.steps[1].frame, false, JSON.stringify(never.steps[1].frame));
});

test("row 23: a target below the fold is scrolled to and clicked; a fixed overlay still obscures", { skip: SKIP }, async () => {
  const mark = server.log.length;
  const deep = await runOn([
    { viewport: { width: 800, height: 400 } },
    { open: { url: "/tall.html" } },
    { click: { target: "#deep" } },
    { expect_visible: { target: "body" } },
  ]);
  assert.equal(deep.outcome, "passed", JSON.stringify(deep.steps));
  const paths = server.log.slice(mark).filter((entry) => entry.method === "GET").map((entry) => entry.path);
  assert.ok(paths.includes("/deep-click"), JSON.stringify(paths));

  const coveredMark = server.log.length;
  const covered = await runOn([
    { viewport: { width: 800, height: 400 } },
    { open: { url: "/tall-covered.html" } },
    { click: { target: "#deep" } },
  ], { requireAssertion: false });
  assert.equal(covered.steps[2].failure, "target_obscured", JSON.stringify(covered.steps[2]));
  assert.equal(server.log.slice(coveredMark).some((entry) => entry.path === "/deep-click"), false);
});

test("row 24: run --viewport phone applies the built-in dpr, and capture measures the same density", { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-probe-density-"));
  try {
    const scenario = join(dir, "density.yaml");
    writeFileSync(scenario, [
      "id: density",
      "steps:",
      `  - open: { url: "${server.path("/density.html")}" }`,
      '  - expect_widths: { target: "#density", equals: 30, timeoutMs: 0 }',
      "",
    ].join("\n"));
    writeFileSync(join(dir, ".ui-probe.json"), JSON.stringify({
      baseUrl: server.origin,
      browser: browserPath,
      screens: { density: { url: "/density.html", measure: ["#density"] } },
    }, null, 2));

    const ran = await probeCli(["run", scenario, "--viewport", "phone"], dir);
    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /PASSED \S+ expect_widths #density measured=\[30\]/, ran.stdout);

    const out = join(dir, "out");
    const captured = await probeCli(["capture", "density", "--viewport", "phone", "--out", out], dir);
    assert.equal(captured.status, 0, `${captured.stdout}${captured.stderr}`);
    assert.equal(readJson(join(out, "phone", "measure.json"))["#density"][0].width, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 11: a target covered at its centre gives target_obscured", { skip: SKIP }, async () => {
  const result = await runOn(steps("/covered.html", { click: { target: "#covered" } }), { requireAssertion: false });
  assert.equal(result.steps[1].failure, "target_obscured");
});

test("row 7: a POST-form submit is write_blocked before input, and --allow-writes lets it through", { skip: SKIP }, async () => {
  const blockedMark = server.log.length;
  const blocked = await runOn(steps("/form-post.html", { click: { target: "#submit" } }, { expect_visible: { target: "#done" } }));
  assert.equal(blocked.outcome, "failed");
  assert.equal(blocked.steps[1].failure, "write_blocked");
  assert.equal(blocked.steps[2].outcome, "not_run");
  assert.equal(server.log.slice(blockedMark).filter((entry) => entry.method === "POST").length, 0);

  const allowedMark = server.log.length;
  const allowed = await runOn(steps("/form-post.html", { click: { target: "#submit" } }, { expect_visible: { target: "#done" } }), { allowWrites: true });
  assert.equal(allowed.outcome, "passed");
  const posts = server.log.slice(allowedMark).filter((entry) => entry.method === "POST");
  assert.deepEqual(posts.map((entry) => entry.path), ["/recommend/action"]);
});

test("row 6: the Fetch guard fails a scripted POST and network.json records it as blocked", { skip: SKIP }, async () => {
  const mark = server.log.length;
  const dir = outDir("guard");
  await capture({
    url: "/script-post.html",
    steps: [{ click: { target: "#send" } }, { expect_text: { target: "#status", equals: "blocked" } }],
  }, { config: config(), cdp: client, outDir: dir, viewports: ["desktop"] });

  assert.equal(server.log.slice(mark).filter((entry) => entry.method === "POST").length, 0);
  const network = readJson(join(dir, "desktop", "network.json"));
  const post = network.find((entry) => entry.method === "POST");
  assert.ok(post, JSON.stringify(network));
  assert.equal(post.blocked, true);
  assert.match(post.url, /\/recommend\/action$/);
});

test("row 8: env.json reports hover:none/pointer:coarse at phone and hover:hover/pointer:fine at desktop", { skip: SKIP }, async () => {
  const dir = outDir("env");
  const { digest } = await capture({ url: "/tiles-good.html" }, { config: config(), cdp: client, outDir: dir, viewports: ["phone", "desktop"] });

  const phone = readJson(join(dir, "phone", "env.json"));
  assert.equal(phone.hover_none, true);
  assert.equal(phone.hover_hover, false);
  assert.equal(phone.pointer_coarse, true);
  assert.equal(phone.pointer_fine, false);

  const desktop = readJson(join(dir, "desktop", "env.json"));
  assert.equal(desktop.hover_hover, true);
  assert.equal(desktop.hover_none, false);
  assert.equal(desktop.pointer_fine, true);
  assert.equal(desktop.pointer_coarse, false);

  assert.match(digest, /^phone 390×844 hover:none pointer:coarse$/m);
  assert.match(digest, /^desktop 1280×900 hover:hover pointer:fine$/m);
});

test("row 5: the cookie value appears in no output file and not on the digest", { skip: SKIP }, async () => {
  const secret = "SECRET-COOKIE-2f7a";
  const dir = outDir("cookie");
  const { digest } = await capture({ url: "/tiles-good.html", measure: ["[data-testid=action-tile]"] }, {
    config: config({ auth: { cookies: [{ name: "session", command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(secret)})`] }] } }),
    cdp: client,
    outDir: dir,
    viewports: ["desktop"],
  });

  const files = filesUnder(dir);
  assert.deepEqual(files.map((file) => file.split(/[\\/]/).pop()).sort(), [
    "assets.json", "console.json", "dom.html", "env.json", "measure.json", "network.json", "observation.txt", "screenshot.png",
  ]);
  const needle = Buffer.from(secret);
  for (const file of files) assert.equal(readFileSync(file).includes(needle), false, `cookie leaked into ${file}`);
  assert.equal(digest.includes(secret), false, "cookie leaked onto stdout");
});

test("row 27: run sets the config's auth cookies before its first step, and leaks none", { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-probe-run-cookie-"));
  try {
    const scenario = join(dir, "signed-in.yaml");
    writeFileSync(scenario, [
      "id: signed-in",
      "steps:",
      `  - open: { url: "${server.path("/signed-in.html")}" }`,
      '  - expect_text: { target: "#who", equals: "signed in" }',
      "",
    ].join("\n"));
    const writeConfig = (auth) => writeFileSync(
      join(dir, ".ui-probe.json"),
      JSON.stringify({ baseUrl: server.origin, browser: browserPath, ...(auth ? { auth } : {}) }, null, 2),
    );
    const auth = { cookies: [{ name: "session", command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(AUTH_COOKIE)})`] }] };

    writeConfig(auth);
    const out = join(dir, "out");
    const signedIn = await probeCli(["run", scenario, "--out", out], dir);
    assert.equal(signedIn.status, 0, `${signedIn.stdout}${signedIn.stderr}`);
    assert.match(signedIn.stdout, /^PASSED \S+ expect_text #who measured="signed in"/m, signedIn.stdout);
    const results = readFileSync(join(out, "results.json"), "utf8");
    assert.equal(results.includes(AUTH_COOKIE), false, "the cookie leaked into results.json");

    // RED control: the same scenario without a cookie never gets the signed-in page.
    writeConfig(null);
    const signedOut = await probeCli(["run", scenario, "--out", join(dir, "out-anon")], dir);
    assert.equal(signedOut.status, 1, `without a cookie the run must fail: ${signedOut.stdout}${signedOut.stderr}`);
    assert.match(signedOut.stdout, /^FAILED \S+ expect_text #who/m, signedOut.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 12: an aria-modal dialog hides the background, and include-background adds it", { skip: SKIP }, async () => {
  const only = outDir("dialog");
  await capture({ url: "/dialog.html" }, { config: config(), cdp: client, outDir: only, viewports: ["desktop"] });
  const observation = readFileSync(join(only, "desktop", "observation.txt"), "utf8");
  assert.match(observation, /OK/);
  assert.doesNotMatch(observation, /Background heading/);

  const both = outDir("dialog-background");
  await capture({ url: "/dialog.html" }, { config: config(), cdp: client, outDir: both, viewports: ["desktop"], includeBackground: true });
  const withBackground = readFileSync(join(both, "desktop", "observation.txt"), "utf8");
  assert.match(withBackground, /OK/);
  assert.match(withBackground, /Background heading/);
});

test("row 20: the observation carries pressed, checked, expanded and disabled", { skip: SKIP }, async () => {
  const dir = outDir("aria");
  await capture({ url: "/aria.html" }, { config: config(), cdp: client, outDir: dir, viewports: ["desktop"] });
  const observation = readFileSync(join(dir, "desktop", "observation.txt"), "utf8");
  assert.match(observation, /button "Notify me" \[pressed=true\]/);
  assert.match(observation, /\[checked=true\]/);
  assert.match(observation, /\[expanded=false\]/);
  assert.match(observation, /\[disabled=true\]/);
});

test("row 28: a display:contents wrapper is visible through a visible child, hidden with only hidden children", { skip: SKIP }, async () => {
  const shown = await runOn(steps("/contents.html", { expect_visible: { target: "#wraps-button", timeoutMs: 0 } }));
  assert.equal(shown.outcome, "passed", JSON.stringify(shown.steps));
  assert.equal(shown.steps[1].measured, true);

  const hidden = await runOn(steps("/contents.html", { expect_hidden: { target: "#wraps-hidden", timeoutMs: 0 } }));
  assert.equal(hidden.outcome, "passed", JSON.stringify(hidden.steps));
});

test("row 21: UI_PROBE_REQUIRE_BROWSER=1 fails naming the missing browser instead of skipping", { skip: IS_CHILD }, () => {
  const missing = join(tmpdir(), "ui-probe-no-such-browser.exe");
  const file = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, ["--test", file], {
    encoding: "utf8",
    timeout: 240000,
    env: childEnv({ UI_PROBE_REQUIRE_BROWSER: "1", UI_PROBE_BROWSER: missing, UI_PROBE_CHILD: "1" }),
  });
  const output = `${child.stdout}${child.stderr}`;
  assert.notEqual(child.status, 0, output);
  assert.ok(output.includes(missing), output);

  const relaxed = spawnSync(process.execPath, ["--test", file], {
    encoding: "utf8",
    timeout: 240000,
    env: childEnv({ UI_PROBE_REQUIRE_BROWSER: "", UI_PROBE_BROWSER: missing, UI_PROBE_CHILD: "1" }),
  });
  assert.equal(relaxed.status, 0, `${relaxed.stdout}${relaxed.stderr}`);
  assert.match(`${relaxed.stdout}${relaxed.stderr}`, /skipping|no browser/);
});

test("row 10: expect_within safe passes inside, fails 6px past, and the hold catches a late scale", { skip: SKIP }, async () => {
  const inside = await runTv(steps("/tv-grid.html", { expect_within: { target: "#probe-safe", box: "safe", timeoutMs: 1000 } }));
  assert.equal(inside.outcome, "passed", JSON.stringify(inside.steps));
  assert.equal(inside.steps[1].measured.left, 96);
  assert.equal(inside.steps[1].measured.right, 1824);

  const past = await runTv(steps("/tv-grid.html", { expect_within: { target: "#probe-past", box: "safe", timeoutMs: 0 } }));
  assert.equal(past.outcome, "failed");
  assert.ok(past.steps[1].measured.right > 1824, JSON.stringify(past.steps[1]));

  const caught = await runTv(steps("/tv-grid.html", { key: { key: "Digit1" } }, { expect_within: { target: "#scaler", box: "safe" } }));
  assert.equal(caught.outcome, "failed", JSON.stringify(caught.steps));
  assert.ok(caught.steps[2].measured.right > 1824, JSON.stringify(caught.steps[2]));

  // RED control: without the hold, the first in-bounds sample is the whole assertion.
  const loose = await runTv(steps("/tv-grid.html", { key: { key: "Digit1" } }, { expect_within: { target: "#scaler", box: "safe", holdMs: 0 } }));
  assert.equal(loose.outcome, "passed", JSON.stringify(loose.steps));
});

test("row 11: expect_prop reads paused/currentTime and expect_count counts video elements", { skip: SKIP }, async () => {
  const playing = await runTv(steps("/tv-grid.html", { expect_prop: { target: "#clip", property: "paused", equals: false } }));
  assert.equal(playing.outcome, "passed", JSON.stringify(playing.steps));
  assert.equal(playing.steps[1].measured, false);

  const advancing = await runTv(steps("/tv-grid.html", { expect_prop: { target: "#clip", property: "currentTime", gt: 0 } }));
  assert.equal(advancing.outcome, "passed", JSON.stringify(advancing.steps));

  const wrong = await runTv(steps("/tv-grid.html", { expect_prop: { target: "#clip", property: "paused", equals: true, timeoutMs: 0 } }));
  assert.equal(wrong.outcome, "failed");
  assert.equal(wrong.steps[1].measured, false);

  const count = await runTv(steps("/tv-grid.html", { expect_count: { target: "video", equals: 1 } }));
  assert.equal(count.outcome, "passed", JSON.stringify(count.steps));
  const wrongCount = await runTv(steps("/tv-grid.html", { expect_count: { target: "video", equals: 2, timeoutMs: 0 } }));
  assert.equal(wrongCount.outcome, "failed");
  assert.equal(wrongCount.steps[1].measured, 1);
});

test("row 12: over mode all fails when the text changes mid-window and passes when the window closes first", { skip: SKIP }, async () => {
  const late = await runTv(steps("/tv-grid.html", { key: { key: "Digit2" } }, { expect_text: { target: "#timed-text", equals: "before", over: 400, mode: "all" } }));
  assert.equal(late.outcome, "failed");
  assert.equal(late.steps[2].measured, "after");

  const early = await runTv(steps("/tv-grid.html", { key: { key: "Digit2" } }, { expect_text: { target: "#timed-text", equals: "before", over: 200, mode: "all" } }));
  assert.equal(early.outcome, "passed", JSON.stringify(early.steps));

  // mode any keeps phase 1's rule: one matching frame is enough.
  const any = await runTv(steps("/tv-grid.html", { key: { key: "Digit2" } }, { expect_text: { target: "#timed-text", equals: "before", over: 400, mode: "any" } }));
  assert.equal(any.outcome, "passed", JSON.stringify(any.steps));
});

test("row 14: the grid journey moves focus, opens, closes and exits; repeat 20 stops at the row end", { skip: SKIP }, async () => {
  const journey = await runTv(steps("/tv-grid.html",
    { key: { key: "Right" } }, { key: { key: "Right" } }, { key: { key: "Down" } },
    { expect_text: { target: "#focus-label", equals: "Six" } },
    { key: { key: "Enter" } },
    { expect_css: { target: "#player", property: "display", equals: "block" } },
    { expect_text: { target: "#player-title", equals: "Six" } },
    { key: { key: "Back" } },
    { expect_css: { target: "#player", property: "display", equals: "none" } },
    { key: { key: "Back" } },
    { expect_css: { target: "#exit-popup", property: "display", equals: "block" } }));
  assert.equal(journey.outcome, "passed", JSON.stringify(journey.steps));

  const held = await runTv(steps("/tv-grid.html",
    { key: { key: "Right", repeat: 20, gapMs: 5 } },
    { expect_text: { target: "#focus-label", equals: "Three" } },
    { expect_count: { target: ".focused", equals: 1 } }));
  assert.equal(held.outcome, "passed", JSON.stringify(held.steps));
});

test("row 18: the DOM walk marks the focus selector, and a key Down moves the mark", { skip: SKIP }, async () => {
  await runTv(steps("/tv-grid.html"), { requireAssertion: false });
  // The M69 protocol has no getFullAXTree; that, not the device name, picks the walk.
  const protocol = { domains: [{ domain: "Accessibility", commands: [{ name: "getPartialAXTree" }] }] };
  const focusedLine = (text) => text.split("\n").find((line) => line.includes("[focused]")) ?? "";

  const before = focusedLine(await observe(client, { protocol }));
  assert.match(before, /#tile-one/, before);

  await dispatchKey(client, "Down");
  const after = focusedLine(await observe(client, { protocol }));
  assert.match(after, /#tile-four/, after);
  assert.notEqual(after, before);
});
