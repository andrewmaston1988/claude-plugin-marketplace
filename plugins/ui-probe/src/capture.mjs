// One-shot capture: emulate, navigate, run the screen's steps, then write the eight outputs.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./cdp.mjs";
import { resolveCookies } from "./auth.mjs";
import { installFetchGuard } from "./guard.mjs";
import { observe } from "./observe.mjs";
import { navigate, run } from "./runner.mjs";

const ENV_JS = `(() => {
  const m = (query) => matchMedia(query).matches;
  return {
    hover_hover: m('(hover: hover)'), hover_none: m('(hover: none)'),
    pointer_fine: m('(pointer: fine)'), pointer_coarse: m('(pointer: coarse)'),
    any_hover: m('(any-hover: hover)'), any_pointer_fine: m('(any-pointer: fine)'),
    maxTouchPoints: navigator.maxTouchPoints,
    touchEvent: 'ontouchstart' in window,
    innerWidth: innerWidth, innerHeight: innerHeight,
    dpr: devicePixelRatio,
    ua: navigator.userAgent,
  };
})()`;

const MEASURE_JS = (selectors) => `(() => {
  const out = {};
  for (const selector of ${JSON.stringify(selectors)}) {
    out[selector] = Array.from(document.querySelectorAll(selector)).map((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  }
  return out;
})()`;

function absoluteUrl(url, baseUrl) {
  if (/^https?:\/\//.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, "")}${url}`;
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

const writeJson = (file, value) => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

const round = (value) => Math.round(value * 10) / 10;

async function emulate(cdp, viewport) {
  const touch = Boolean(viewport.touch);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.dpr ?? 1,
    mobile: touch,
  });
  const touchParams = touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false };
  await cdp.send("Emulation.setTouchEmulationEnabled", touchParams);
}

function networkLog(requests, blocked) {
  const entries = [...requests.values()].map(({ method, url, status }) => ({
    method, url, status: status ?? null, blocked: false,
  }));
  for (const stop of blocked) {
    const hit = entries.find((entry) => entry.method === stop.method && entry.url === stop.url);
    if (hit) hit.blocked = true;
    else entries.push({ method: stop.method, url: stop.url, status: null, blocked: true });
  }
  return entries;
}

function assetList(requests) {
  return [...requests.values()]
    .filter((request) => request.type)
    .map(({ url, type }) => ({ url, type }));
}

function listen(cdp, events) {
  return [
    cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
      events.requests.set(requestId, { method: request.method, url: request.url, status: null, type: null });
    }),
    cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
      const entry = events.requests.get(requestId);
      if (!entry) return;
      entry.status = response.status;
      entry.type = type;
    }),
    cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
      events.console.push({ level: type, text: args.map((arg) => arg.value ?? arg.description ?? "").join(" ") });
    }),
    cdp.on("Log.entryAdded", ({ entry }) => {
      events.console.push({ level: entry.level, text: entry.text });
    }),
  ];
}

/**
 * Capture a screen at each viewport. `ctx.cdp` is a connected page-level client (or a factory);
 * one browser serves every viewport, each with its own directory under `outDir`.
 */
export async function capture(screen, ctx = {}) {
  const config = ctx.config;
  if (!config?.baseUrl) throw new Error("capture() needs ctx.config with a baseUrl");
  const cdp = typeof ctx.cdp === "function" ? await ctx.cdp() : ctx.cdp;
  if (!cdp) throw new Error("capture() needs ctx.cdp (a connected CDP client)");

  const outDir = ctx.outDir ?? config.outDir;
  const viewportNames = ctx.viewports ?? ["phone", "desktop"];
  const url = absoluteUrl(screen.url, config.baseUrl);
  const selectors = screen.measure ?? [];
  const allowWrites = Boolean(ctx.allowWrites);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  try { await cdp.send("Log.enable"); } catch { /* Log is optional on older Chromium */ }

  const events = { requests: new Map(), console: [] };
  const offs = listen(cdp, events);
  const blocked = [];
  const guard = await installFetchGuard(cdp, { allowWrites, blocked });
  const cookies = await resolveCookies(config, ctx.vars ?? {}, { _spawn: ctx._spawn });
  const lines = [];

  try {
    for (const name of viewportNames) {
      const viewport = config.viewports?.[name];
      if (!viewport) {
        throw new Error(`unknown viewport ${JSON.stringify(name)} — the config has ${Object.keys(config.viewports ?? {}).join(", ")}`);
      }
      events.requests.clear();
      events.console.length = 0;
      blocked.length = 0;

      const dir = join(outDir, name);
      mkdirSync(dir, { recursive: true });

      await emulate(cdp, viewport);
      for (const cookie of cookies) {
        const params = { name: cookie.name, value: cookie.value, path: "/" };
        if (cookie.domain) params.domain = cookie.domain;
        else params.url = url;
        await cdp.send("Network.setCookie", params);
      }

      await navigate(cdp, url, { timeoutMs: ctx.loadTimeoutMs });

      let steps = null;
      if (screen.steps?.length) {
        steps = await run(
          { id: "capture", steps: screen.steps },
          {
            cdp, baseUrl: config.baseUrl, allowWrites, guard, blocked,
            requireAssertion: false, source: ctx.source ?? name,
            loadTimeoutMs: ctx.loadTimeoutMs,
          },
        );
      }

      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeAtomic(join(dir, "screenshot.png"), Buffer.from(shot.data, "base64"));
      writeAtomic(join(dir, "dom.html"), (await evaluate(cdp, "document.documentElement.outerHTML")) ?? "");
      const measure = selectors.length ? await evaluate(cdp, MEASURE_JS(selectors)) : {};
      writeJson(join(dir, "measure.json"), measure);
      writeJson(join(dir, "console.json"), events.console);
      writeJson(join(dir, "network.json"), networkLog(events.requests, blocked));
      writeJson(join(dir, "assets.json"), assetList(events.requests));
      const env = await evaluate(cdp, ENV_JS);
      writeJson(join(dir, "env.json"), env);
      writeAtomic(join(dir, "observation.txt"), await observe(cdp, { includeBackground: Boolean(ctx.includeBackground) }));

      lines.push(`${name} ${viewport.width}×${viewport.height} hover:${env.hover_none ? "none" : "hover"} pointer:${env.pointer_coarse ? "coarse" : "fine"}`);
      for (const selector of selectors) {
        const widths = (measure[selector] ?? []).map((box) => round(box.width)).join(",");
        lines.push(`${selector} widths=${widths}`);
      }
      if (steps && steps.outcome !== "passed") lines.push(`steps: ${steps.outcome}`);
      lines.push(`blocked: ${blocked.length}`);
      lines.push(`out: ${dir}`);
    }
  } finally {
    for (const off of offs) off();
    await guard.uninstall();
  }

  return { digest: lines.join("\n"), outDir };
}
