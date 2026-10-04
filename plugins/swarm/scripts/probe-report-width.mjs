#!/usr/bin/env node
// Real-browser proof that report content fits a 412px phone and follows dark mode.
// Outside `npm test`: node plugins/swarm/scripts/probe-report-width.mjs

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mdToHtml } from "../src/md_to_html.mjs";
import { connect, devtoolsPort, evaluate, findBrowser, getJson, pageTarget, sleep } from "./lib/cdp.mjs";

const WIDTH = 412;
const LONG_PATH = "src/stonk/research/very_module_name/decision_table_helpers.py";
const CITE = "src/stonk/research/decision_table.py:760";
if (LONG_PATH.length !== 61 || CITE.length !== 40) throw new Error("probe fixture lengths changed");
const fixture = `A long inline path: \`${LONG_PATH}\`\n\nA citation that also needs room: ${CITE}`;
let browser = null;
let browserWs = null;
let client = null;
let tempDir = null;

async function shutdown() {
  try { await browserWs?.send("Browser.close"); } catch {}
  browserWs?.close();
  client?.close();
  const exited = browser && await Promise.race([
    new Promise((resolve) => browser.once("exit", () => resolve(true))),
    sleep(4000).then(() => false),
  ]);
  if (!exited && browser) {
    try { spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  let exe;
  try { exe = findBrowser(); }
  catch (error) {
    console.log(`SKIP — ${error.message}`);
    return;
  }

  tempDir = mkdtempSync(join(tmpdir(), "swarm-report-width-"));
  const htmlPath = join(tempDir, "fixture.html");
  const profile = join(tempDir, "profile");
  writeFileSync(htmlPath, mdToHtml(fixture, { title: "Report width probe" }), "utf8");
  browser = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const port = await devtoolsPort(profile, browser);
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    browserWs = await connect(version.webSocketDebuggerUrl);
    const target = await pageTarget(port);
    client = await connect(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", { url: pathToFileURL(htmlPath).href });
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH, height: 915, deviceScaleFactor: 2.625, mobile: true,
    });
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await sleep(150);
    const measurements = await evaluate(client, `({
      scrollWidth: document.documentElement.scrollWidth,
      background: getComputedStyle(document.body).backgroundColor,
    })`);
    const widthPass = measurements.scrollWidth <= WIDTH;
    const darkPass = measurements.background !== "rgb(255, 255, 255)" && measurements.background !== "rgba(0, 0, 0, 0)";
    console.log(`${widthPass ? "PASS" : "FAIL"} — documentElement.scrollWidth ${measurements.scrollWidth}px <= ${WIDTH}px`);
    console.log(`${darkPass ? "PASS" : "FAIL"} — dark body background ${measurements.background} is not white or transparent`);
    if (!widthPass || !darkPass) process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

await main();