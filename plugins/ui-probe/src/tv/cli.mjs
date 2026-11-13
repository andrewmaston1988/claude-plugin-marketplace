// TV branches of the CLI: attach for run and capture, `tv probe`, and doctor's TV checks.
// Loaded by dynamic import only, so a web user never pays for sdb or the attach path.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attach, AttachInconclusive } from './attach.mjs';
import { findSdb, listedDevices, sdb } from './sdb.mjs';
import { platformPath, tvProbe } from './probe.mjs';
import { interceptionKind, inTvScope, tvWritePolicy } from '../guard.mjs';

export { AttachInconclusive };

/** A refusal the CLI reports as exit 64: the request cannot be honoured as asked. */
export class TvRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'TvRefusal';
  }
}

/**
 * The write policy for a TV invocation. `hasInterception` is true until an attach reports the
 * target's protocol, so the config-only rules can fire before an attach costs seconds.
 */
export function tvRefusal(config, {
  backend = null,
  device = null,
  allowWrites = false,
  hasInterception = true,
  opens = [],
} = {}) {
  return tvWritePolicy({
    tvScope: inTvScope({ backend, device }),
    allowWrites,
    testOrigin: config?.tv?.testOrigin ?? null,
    hasInterception,
    opens,
  });
}

export function assertTvPolicy(config, options) {
  const why = tvRefusal(config, options);
  if (why) throw new TvRefusal(why);
}

/** Every `open` a scenario will navigate to, in either step shape. */
export function scenarioOpens(doc) {
  const opens = [];
  for (const step of doc?.steps ?? []) {
    if (step && typeof step === 'object' && 'open' in step) opens.push(step.open);
  }
  return opens;
}

/** Attach for run or capture. The caller always detaches; the protocol picks the guard. */
export async function tvSession(config, { attachPort = null, _attach = attach } = {}) {
  if (!config?.tv?.host || !config?.tv?.appid) {
    throw new TvRefusal('the tv device needs a tv block with host and appid in .ui-probe.json');
  }
  const session = await _attach(config, { attachPort });
  return {
    cdp: session.cdp,
    port: session.port,
    protocol: session.protocol,
    intercepted: interceptionKind(session.protocol) !== null,
    detach: session.detach,
  };
}

/**
 * A scenario on the set. One attach for the whole run, and the write policy is judged again once
 * the protocol says whether this target can intercept at all.
 */
export async function runOnTv({
  doc,
  config,
  attachPort = null,
  allowWrites = false,
  cookies = [],
  baseUrl = null,
  source = null,
  baseDir = null,
  file = null,
  _attach = attach,
  _run = null,
} = {}) {
  const opens = scenarioOpens(doc);
  const device = 'tv';
  assertTvPolicy(config, { backend: doc?.backend ?? null, device, allowWrites, opens });

  const session = await tvSession(config, { attachPort, _attach });
  try {
    assertTvPolicy(config, { backend: doc?.backend ?? null, device, allowWrites, hasInterception: session.intercepted, opens });
    const run = _run ?? (await import('../runner.mjs')).run;
    const result = await run(doc, {
      cdp: session.cdp,
      protocol: session.protocol,
      device: 'tv',
      baseUrl,
      allowWrites,
      cookies,
      testOrigin: config?.tv?.testOrigin ?? null,
      source,
      baseDir,
      file,
    });
    return { result, port: session.port };
  } finally {
    await session.detach();
  }
}

/**
 * A capture on the set: the app is already loaded, so there is one viewport and no navigation.
 */
export async function captureOnTv({
  screen,
  config,
  attachPort = null,
  allowWrites = false,
  screenshot = false,
  includeBackground = false,
  outDir = undefined,
  source = null,
  baseDir = null,
  file = null,
  _attach = attach,
} = {}) {
  const opens = scenarioOpens({ steps: screen?.steps ?? [] });
  assertTvPolicy(config, { device: 'tv', allowWrites, opens });

  const session = await tvSession(config, { attachPort, _attach });
  try {
    assertTvPolicy(config, { device: 'tv', allowWrites, hasInterception: session.intercepted, opens });
    const { capture } = await import('../capture.mjs');
    return await capture(screen, {
      config,
      cdp: session.cdp,
      protocol: session.protocol,
      device: 'tv',
      allowWrites,
      screenshot,
      includeBackground,
      outDir,
      source,
      baseDir,
      file,
    });
  } finally {
    await session.detach();
  }
}

/** Write the platform record to the out dir and to the copy capture reads. */
export async function tvProbeCommand({
  config,
  outDir = undefined,
  video = null,
  navigate = null,
  listenSeconds = null,
  attachPort = null,
  _attach = attach,
  _tvProbe = tvProbe,
} = {}) {
  if (!config?.tv?.appid) throw new TvRefusal('tv probe needs a tv block with host and appid in .ui-probe.json');

  const session = await tvSession(config, { attachPort, _attach });
  let platform;
  try {
    platform = await _tvProbe(session.cdp, { video, navigate, listenSeconds });
  } finally {
    await session.detach();
  }

  const dir = outDir ?? config.outDir;
  writeJson(join(dir, 'platform.json'), platform);
  writeJson(platformPath(config.tv.appid), platform);
  return { platform, outDir: dir, lines: probeLines(platform, dir) };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function probeLines(platform, dir) {
  const features = platform.features ?? {};
  const navigate = platform.navigate ?? {};
  const video = platform.video ?? {};
  const keys = platform.keys ?? {};
  const listen = platform.listen ?? {};
  const lines = [
    `features: tizen ${features.tizen ?? 'unknown'}, webapis ${features.webapis ?? 'unknown'}, `
      + `registerKey ${features.registerKey?.outcome ?? 'absent'}, `
      + `getCurrentApplication ${features.getCurrentApplication?.outcome ?? 'absent'}`,
    `navigate: ${navigate.status ?? 'skipped'}${navigate.requested ? ` ${navigate.requested}` : ''}`
      + `${navigate.location ? ` -> ${navigate.location}` : ''}`,
  ];

  if (video.status === 'measured') {
    lines.push(`video: muted play ${video.mutedPlay}, readyState ${video.readyState}, `
      + `advanced ${video.advanced}, unmuted play ${video.unmutedPlay}`);
  } else {
    lines.push(`video: ${video.status ?? 'skipped'}${video.reason ? ` — ${video.reason}` : ''}`);
  }

  const withheld = keys.onFixture ? '' : ' (Back and Enter withheld: not on the test origin)';
  lines.push(`keys: ${keys.events?.length ?? 0} events from ${keys.dispatched?.length ?? 0} keys${withheld}`);

  if (listen.status === 'measured') lines.push(`listen: ${listen.events?.length ?? 0} physical events in ${listen.seconds}s`);
  else lines.push('listen: skipped');

  lines.push(`out: ${dir}`);
  lines.push(platform.verdict);
  return lines;
}

function portFrom(getFlag, rest) {
  const raw = getFlag("--attach-port", rest);
  if (raw === null) return { port: null, problem: null };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: null, problem: `--attach-port needs a port number, got ${JSON.stringify(raw)}` };
  }
  return { port, problem: null };
}

/** A branch's outcome: the exit code plus whatever the CLI still has to print. */
async function branch(work) {
  try {
    return { exitCode: 0, ...(await work()) };
  } catch (error) {
    if (error instanceof TvRefusal) return { exitCode: 64, stderr: error.message };
    if (error instanceof AttachInconclusive) return { exitCode: 2, stderr: `inconclusive: tv: ${error.message}` };
    throw error;
  }
}

/** `run --device tv`. */
export function runTvBranch({
  doc, config, rest, getFlag, cookies = [], baseUrl = null, source = null,
  baseDir = null, file = null, _attach = attach, _run = null,
}) {
  const { port, problem } = portFrom(getFlag, rest);
  if (problem) return { exitCode: 64, stderr: problem };
  return branch(async () => {
    const { result } = await runOnTv({
      doc, config, attachPort: port, allowWrites: rest.includes("--allow-writes"),
      cookies, baseUrl, source, baseDir, file, _attach, _run,
    });
    return { result };
  });
}

/** `capture --device tv`. */
export function captureTvBranch({ screen, config, rest, getFlag, source = null, baseDir = null, file = null, _attach = attach }) {
  const { port, problem } = portFrom(getFlag, rest);
  if (problem) return { exitCode: 64, stderr: problem };
  return branch(async () => {
    const { digest } = await captureOnTv({
      screen,
      config,
      attachPort: port,
      allowWrites: rest.includes("--allow-writes"),
      screenshot: rest.includes("--screenshot"),
      includeBackground: rest.includes("--include-background"),
      outDir: getFlag("--out", rest) ?? undefined,
      source,
      baseDir,
      file,
      _attach,
    });
    return { digest };
  });
}

/** `tv probe`. */
export async function tvProbeBranch({ config, rest, getFlag, resolveOutDir, out, err }) {
  const listen = getFlag("--listen", rest);
  if (listen !== null && !(Number.isFinite(Number(listen)) && Number(listen) > 0)) {
    err(`--listen needs a positive number of seconds, got ${JSON.stringify(listen)}`);
    return { exitCode: 64 };
  }
  const { port, problem } = portFrom(getFlag, rest);
  if (problem) {
    err(problem);
    return { exitCode: 64 };
  }
  return branch(async () => {
    const { lines } = await tvProbeCommand({
      config,
      outDir: resolveOutDir(config, getFlag("--out", rest)),
      video: getFlag("--video", rest),
      navigate: getFlag("--navigate", rest),
      listenSeconds: listen === null ? null : Number(listen),
      attachPort: port,
    });
    for (const line of lines) out(line);
    return {};
  });
}

/** `'Torrent Hub' 'torrenthub.main'` -> torrenthub.main, for each line applist prints. */
export function appIds(stdout) {
  const ids = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const quoted = [...line.matchAll(/'([^']*)'/g)].map((match) => match[1]).filter(Boolean);
    if (quoted.length) ids.push(quoted[quoted.length - 1]);
  }
  return ids;
}

/**
 * The TV's three checks. Skipped entirely when the config has no tv block, so a web-only machine
 * or CI never needs the Tizen SDK.
 */
export function doctorTv(config, { out, err, _findSdb = findSdb, _sdb = null } = {}) {
  const callSdb = _sdb ?? ((args) => sdb(args, { config }));
  const exe = _findSdb(config);
  if (!exe) {
    err('FAIL tv.sdb: sdb not found — set tv.sdb in .ui-probe.json, put sdb on PATH, or install the Tizen SDK');
    return false;
  }
  out(`ok   tv.sdb: ${exe}`);

  let devices;
  try {
    devices = callSdb(['devices']);
  } catch (error) {
    err(`FAIL tv.device: ${error.message}`);
    return false;
  }
  if (!listedDevices(devices.stdout).includes(config.tv.host)) {
    // attach() connects a host sdb has not seen yet; doctor does the same, then reads again.
    try { callSdb(['connect', config.tv.host]); } catch { /* the check below reports it */ }
    try {
      devices = callSdb(['devices']);
    } catch (error) {
      err(`FAIL tv.device: ${error.message}`);
      return false;
    }
    if (!listedDevices(devices.stdout).includes(config.tv.host)) {
      err(`FAIL tv.device: ${config.tv.host} is not listed by sdb — developer mode may have expired (it lasts two weeks), or the TV is off`);
      return false;
    }
  }
  out(`ok   tv.device: ${config.tv.host}`);

  let list;
  try {
    list = callSdb(['shell', '0', 'applist']);
  } catch (error) {
    err(`FAIL tv.appid: ${error.message}`);
    return false;
  }
  const ids = appIds(list.stdout);
  if (!ids.includes(config.tv.appid)) {
    const installed = ids.length ? ids.join(', ') : '(none)';
    err(`FAIL tv.appid: ${config.tv.appid} is not installed — sdb applist has: ${installed}`);
    return false;
  }
  out(`ok   tv.appid: ${config.tv.appid}`);
  return true;
}
