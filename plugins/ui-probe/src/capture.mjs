// One-shot capture: emulate, navigate, run the screen's steps, then write the eight outputs.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, sleep } from "./cdp.mjs";
import { resolveCookies, setCookies } from "./auth.mjs";
import { installGuard } from "./guard.mjs";
import { observe } from "./observe.mjs";
import { navigate, run } from "./runner.mjs";
import { digestLine } from "./digest.mjs";
import { platformPath, platformSummary } from "./tv/probe.mjs";

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

const SHOT_SCALE = 0.5;
const REPLAY_TIMEOUT_MS = 10000;

class ScreenshotError extends Error {
  constructor(message, { timeout = false } = {}) {
    super(message);
    this.name = "ScreenshotError";
    this.timeout = timeout;
  }
}

// A CDP call that never answers must not hold the capture: the TV's Page.captureScreenshot
// never does, and a replay at the wrong scale did not either.
function bounded(promise, timeoutMs, message) {
  promise.catch(() => { /* the loser of the race settles later; it must not crash the process */ });
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ScreenshotError(message, { timeout: true })), timeoutMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

const trimLayer = (layer) => ({
  layerId: layer.layerId,
  parentLayerId: layer.parentLayerId ?? null,
  offsetX: layer.offsetX ?? 0,
  offsetY: layer.offsetY ?? 0,
  transform: Array.isArray(layer.transform) ? layer.transform : null,
});

// Half-scale canvas of the viewport; each replayed PNG is already half-scale, so it is drawn at
// its own half-scale offset. A Blob decodes without a URL: a `data:` <img> is refused by the hub.
const COMPOSITE_JS = (layers, painted, images, scale) => `(async () => {
  const scale = ${scale};
  const layers = ${JSON.stringify(layers)};
  const painted = ${JSON.stringify(painted)};
  const images = ${JSON.stringify(images)};
  const byId = new Map(layers.map((layer) => [String(layer.layerId), layer]));
  const offsetOf = (layer) => {
    let x = 0;
    let y = 0;
    let current = layer;
    while (current) {
      x += current.offsetX || 0;
      y += current.offsetY || 0;
      const transform = current.transform;
      if (transform && transform.length >= 16) {
        x += transform[12] || 0;
        y += transform[13] || 0;
      }
      current = current.parentLayerId == null ? null : byId.get(String(current.parentLayerId)) || null;
    }
    return { x: x, y: y };
  };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(innerWidth * scale));
  canvas.height = Math.max(1, Math.round(innerHeight * scale));
  const context = canvas.getContext('2d');
  let drawn = 0;
  for (let i = 0; i < images.length; i += 1) {
    const binary = atob(images[i].slice(images[i].indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j += 1) bytes[j] = binary.charCodeAt(j);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const at = offsetOf(painted[i]);
    context.drawImage(bitmap, (at.x - scrollX) * scale, (at.y - scrollY) * scale);
    drawn += 1;
  }
  return { dataUrl: canvas.toDataURL('image/png'), drawn: drawn, width: canvas.width, height: canvas.height };
})()`;

/**
 * The compositor replay: the only route to an image on M69. Each painting layer is snapshotted
 * and replayed at half scale under its own bound, then composited in the page.
 */
async function tvScreenshot(cdp, { timeoutMs = REPLAY_TIMEOUT_MS, _sleep = sleep } = {}) {
  const started = Date.now();
  let layers = null;
  const off = cdp.on("LayerTree.layerTreeDidChange", (event) => {
    if (Array.isArray(event?.layers)) layers = event.layers;
  });
  try {
    await bounded(cdp.send("LayerTree.enable"), timeoutMs, `LayerTree.enable exceeded ${timeoutMs} ms`);
    const attempts = Math.ceil(timeoutMs / 50);
    for (let i = 0; i < attempts && !layers; i += 1) await _sleep(50);
  } finally {
    off();
  }
  if (!layers) throw new ScreenshotError(`the compositor sent no layer tree within ${timeoutMs} ms`, { timeout: true });

  const all = layers.map(trimLayer);
  const painted = layers.filter((layer) => layer.drawsContent).map(trimLayer);
  if (!painted.length) throw new ScreenshotError("no layer draws content");

  const images = [];
  const snapshots = [];
  try {
    for (const layer of painted) {
      const snapshot = await bounded(
        cdp.send("LayerTree.makeSnapshot", { layerId: layer.layerId }),
        timeoutMs,
        `layer ${layer.layerId} makeSnapshot exceeded ${timeoutMs} ms`,
      );
      snapshots.push(snapshot?.snapshotId);
      const replay = await bounded(
        cdp.send("LayerTree.replaySnapshot", { snapshotId: snapshot?.snapshotId, scale: SHOT_SCALE }),
        timeoutMs,
        `layer ${layer.layerId} replaySnapshot exceeded ${timeoutMs} ms`,
      );
      const dataUrl = replay?.dataURL ?? replay?.data ?? null;
      if (!dataUrl) throw new ScreenshotError(`layer ${layer.layerId} replayed no image`);
      images.push(dataUrl);
    }

    const shot = await bounded(
      evaluate(cdp, COMPOSITE_JS(all, painted, images, SHOT_SCALE)),
      timeoutMs,
      `the in-page composite exceeded ${timeoutMs} ms`,
    );
    if (!shot?.dataUrl) throw new ScreenshotError("the in-page composite returned no image");
    return {
      png: shot.dataUrl,
      env: {
        status: "written",
        layers: layers.length,
        painted: painted.length,
        drawn: shot.drawn ?? painted.length,
        width: shot.width ?? null,
        height: shot.height ?? null,
        ms: Date.now() - started,
      },
    };
  } catch (error) {
    error.layers = layers.length;
    throw error;
  } finally {
    for (const snapshotId of snapshots) {
      if (!snapshotId) continue;
      try { await cdp.send("LayerTree.releaseSnapshot", { snapshotId }); } catch { /* the socket may be gone */ }
    }
    try { await cdp.send("LayerTree.disable"); } catch { /* the socket may be gone */ }
  }
}

function readPlatformSummary(appid) {
  if (!appid) return null;
  try {
    return platformSummary(JSON.parse(readFileSync(platformPath(appid), "utf8")));
  } catch {
    return null; // no probe has run against this app
  }
}

/**
 * `capture --device tv`: the app is already attached and loaded, so there is one viewport and no
 * navigation. The screen is read, never driven, unless the screen's steps say otherwise.
 */
async function captureTv({ screen, config, cdp, ctx, events, guard, blocked, outDir, lines }) {
  const dir = join(outDir, "tv");
  mkdirSync(dir, { recursive: true });
  const selectors = screen.measure ?? [];

  let steps = null;
  if (screen.steps?.length) {
    steps = await run(
      { id: "capture", steps: screen.steps },
      {
        cdp,
        baseUrl: config.baseUrl,
        allowWrites: Boolean(ctx.allowWrites),
        guard,
        blocked,
        requireAssertion: false,
        source: ctx.source ?? "tv",
        loadTimeoutMs: ctx.loadTimeoutMs,
      },
    );
  }

  const screenshot = { status: "skipped" };
  if (ctx.screenshot) {
    const started = Date.now();
    try {
      const shot = await tvScreenshot(cdp, { timeoutMs: ctx._replayTimeoutMs ?? REPLAY_TIMEOUT_MS, _sleep: ctx._sleep });
      writeAtomic(join(dir, "screenshot.png"), Buffer.from(shot.png.slice(shot.png.indexOf(",") + 1), "base64"));
      Object.assign(screenshot, shot.env);
    } catch (error) {
      screenshot.status = error.timeout ? "timeout" : "failed";
      screenshot.layers = error.layers ?? null;
      screenshot.ms = Date.now() - started;
      screenshot.reason = error.message;
    }
  }

  writeAtomic(join(dir, "dom.html"), (await evaluate(cdp, "document.documentElement.outerHTML")) ?? "");
  const measure = selectors.length ? await evaluate(cdp, MEASURE_JS(selectors)) : {};
  writeJson(join(dir, "measure.json"), measure);
  writeJson(join(dir, "console.json"), events.console);
  writeJson(join(dir, "network.json"), networkLog(events.requests, blocked));
  writeJson(join(dir, "assets.json"), assetList(events.requests));

  const env = await evaluate(cdp, ENV_JS);
  const url = await evaluate(cdp, "location.href");
  const platform = readPlatformSummary(config.tv?.appid);
  writeJson(join(dir, "env.json"), {
    ...env,
    url,
    screenshot,
    ...(platform ? { platform } : {}),
  });

  const observation = await observe(cdp, {
    includeBackground: Boolean(ctx.includeBackground),
    focusSelector: config.tv?.focusSelector,
    protocol: ctx.protocol ?? null,
  });
  writeAtomic(join(dir, "observation.txt"), observation);

  lines.push(`tv ${env.innerWidth}×${env.innerHeight} hover:${env.hover_none ? "none" : "hover"} pointer:${env.pointer_coarse ? "coarse" : "fine"}`);
  for (const selector of selectors) {
    const widths = (measure[selector] ?? []).map((box) => round(box.width)).join(",");
    lines.push(`${selector} widths=${widths}`);
  }
  if (steps && steps.outcome !== "passed") {
    lines.push(`steps: ${steps.outcome}`);
    const broken = steps.steps.find((step) => step.outcome !== "passed");
    if (broken) lines.push(digestLine(broken));
  }
  lines.push(`blocked: ${blocked.length}`);
  if (screenshot.status === "written") {
    lines.push(`screenshot: ${screenshot.width}×${screenshot.height}, ${screenshot.drawn} of ${screenshot.layers} layers, ${screenshot.ms} ms`);
  } else if (ctx.screenshot) {
    lines.push(`screenshot: ${screenshot.status} — ${screenshot.reason}`);
  } else {
    lines.push("screenshot: skipped (--screenshot not set)");
  }
  if (platform) lines.push(`platform: ${platform.verdict}`);
  lines.push(`out: ${dir}`);
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
  const guard = await installGuard(cdp, ctx.protocol ?? null, {
    allowWrites,
    blocked,
    ...(ctx.device === "tv" ? { testOrigin: config.tv?.testOrigin ?? null, backend: "tv" } : {}),
  });
  const lines = [];

  try {
    if (ctx.device === "tv") {
      await captureTv({ screen, config, cdp, ctx, events, guard, blocked, outDir, lines });
      return { digest: lines.join("\n"), outDir };
    }

    const cookies = await resolveCookies(config, ctx.vars ?? {}, { _spawn: ctx._spawn });
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
      await setCookies(cdp, cookies, url);

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
      if (steps && steps.outcome !== "passed") {
        lines.push(`steps: ${steps.outcome}`);
        // The step that stopped the run, so the reader never has to re-run it as a scenario.
        const broken = steps.steps.find((step) => step.outcome !== "passed");
        if (broken) lines.push(digestLine(broken));
      }
      lines.push(`blocked: ${blocked.length}`);
      lines.push(`out: ${dir}`);
    }
  } finally {
    for (const off of offs) off();
    await guard.uninstall();
  }

  return { digest: lines.join("\n"), outDir };
}
