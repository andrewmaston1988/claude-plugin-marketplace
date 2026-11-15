// TV branches of the CLI: attach for run and capture, and `tv probe`. The doctor's TV checks live
// in doctor.mjs and are re-exported here so every TV consumer keeps one import path.
// Loaded by dynamic import only, so a web user never pays for sdb or the attach path.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attach, AttachInconclusive } from './attach.mjs';
import { doctorTv } from './doctor.mjs';
import { platformPath, tvProbe } from './probe.mjs';
import { DEFAULT_LISTEN_WAIT_SECONDS, listenLabel, parseListenKeys, registerNote } from './listen.mjs';
import { interceptionKind, inTvScope, NO_PROTOCOL, tvWritePolicy } from '../guard.mjs';
import { expandIncludes } from '../ir.mjs';

export { AttachInconclusive, doctorTv };

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

/**
 * Every `open` a scenario will navigate to, in either step shape, includes already spliced in.
 * A file whose includes cannot be spliced is refused rather than judged on the steps that remain.
 */
export function scenarioOpens(doc, { baseDir = null, file = null } = {}) {
  const { doc: spliced, problems } = expandIncludes(doc, { baseDir, file });
  if (problems.length) {
    throw new TvRefusal(`cannot splice this scenario's includes: ${problems[0].field} ${problems[0].problem}`);
  }
  const opens = [];
  for (const step of spliced?.steps ?? []) {
    if (step && typeof step === 'object' && 'open' in step) opens.push(step.open);
  }
  return opens;
}

/** Whether this invocation puts back the app the widget launched over: config policy, less --stay. */
export function restoreEnabled(config, stay = false) {
  return config?.tv?.returnToApp !== false && !stay;
}

/** `tv return: Apple TV (3201807016597) — returned`, or the bare outcome. Null for a join. */
export function tvReturnLine(record) {
  if (record == null) return null;
  const outcome = record.outcome ?? 'unknown';
  if (!record.id) return `tv return: ${outcome}`;
  const app = record.name ? `${record.name} (${record.id})` : record.id;
  return `tv return: ${app} — ${outcome}`;
}

/** The record beside the command's other output; a joined session has none to write. */
export function writeTvReturn(dir, record, _write = writeJson) {
  if (!dir || record == null) return;
  _write(join(dir, 'tv-return.json'), record);
}

/**
 * Attach for run or capture. The caller always detaches; the protocol picks the guard. The
 * session holds a one-shot SIGINT/SIGTERM handler, so a Ctrl-C kills the widget and restores the
 * app too — the same memoised detach the caller's `finally` reaches.
 */
export async function tvSession(config, {
  attachPort = null,
  returnToApp = null,
  _attach = attach,
  _process = process,
} = {}) {
  if (!config?.tv?.host || !config?.tv?.appid) {
    throw new TvRefusal('the tv device needs a tv block with host and appid in .ui-probe.json');
  }
  const restore = returnToApp ?? restoreEnabled(config);
  const session = await _attach(config, { attachPort, returnToApp: restore });

  async function onSignal() {
    try { await session.detach(); } catch { /* the process is leaving either way */ }
    removeHandlers();
    _process.exit(130);
  }
  function removeHandlers() {
    _process.removeListener?.('SIGINT', onSignal);
    _process.removeListener?.('SIGTERM', onSignal);
  }
  _process.once('SIGINT', onSignal);
  _process.once('SIGTERM', onSignal);

  return {
    cdp: session.cdp,
    port: session.port,
    protocol: session.protocol,
    // A protocol the set would not serve is unknown, not a modern browser: no interception.
    intercepted: interceptionKind(session.protocol ?? NO_PROTOCOL) !== null,
    timings: session.timings ?? null,
    async detach() {
      try {
        return await session.detach();
      } finally {
        removeHandlers();
      }
    },
  };
}

/** The run's error, with the tv record riding along so the bin prints its line on the way out. */
function withReturn(error, tvReturn) {
  if (error && typeof error === 'object') error.tvReturn = tvReturn;
  return error;
}

/**
 * A scenario on the set. One attach for the whole run, and the write policy is judged again once
 * the protocol says whether this target can intercept at all.
 */
export async function runOnTv({
  doc,
  config,
  attachPort = null,
  stay = false,
  allowWrites = false,
  cookies = [],
  baseUrl = null,
  source = null,
  baseDir = null,
  file = null,
  _attach = attach,
  _run = null,
} = {}) {
  const opens = scenarioOpens(doc, { baseDir, file });
  const device = 'tv';
  assertTvPolicy(config, { backend: doc?.backend ?? null, device, allowWrites, opens });

  const session = await tvSession(config, {
    attachPort,
    returnToApp: restoreEnabled(config, stay),
    _attach,
  });
  let outcome;
  let failure = null;
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
    outcome = { result, port: session.port, timings: session.timings };
  } catch (error) {
    failure = error;
  }
  // The record is assembled after the detach: it is the return's outcome, not the journey's.
  const tvReturn = await session.detach();
  if (failure) throw withReturn(failure, tvReturn);
  return { ...outcome, tvReturn };
}

/**
 * A capture on the set: the app is already loaded, so there is one viewport and no navigation.
 */
export async function captureOnTv({
  screen,
  config,
  attachPort = null,
  stay = false,
  allowWrites = false,
  screenshot = false,
  includeBackground = false,
  outDir = undefined,
  source = null,
  baseDir = null,
  file = null,
  _attach = attach,
  _capture = null,
} = {}) {
  // A screen's steps live in the config file, so its includes resolve beside it.
  const includeBase = baseDir ?? config.configDir ?? null;
  const opens = scenarioOpens({ steps: screen?.steps ?? [] }, { baseDir: includeBase, file });
  assertTvPolicy(config, { device: 'tv', allowWrites, opens });

  const session = await tvSession(config, {
    attachPort,
    returnToApp: restoreEnabled(config, stay),
    _attach,
  });
  let outcome;
  let failure = null;
  try {
    assertTvPolicy(config, { device: 'tv', allowWrites, hasInterception: session.intercepted, opens });
    const runCapture = _capture ?? (await import('../capture.mjs')).capture;
    outcome = await runCapture(screen, {
      config,
      cdp: session.cdp,
      protocol: session.protocol,
      device: 'tv',
      allowWrites,
      screenshot,
      includeBackground,
      outDir,
      source,
      baseDir: includeBase,
      file,
      timings: session.timings,
    });
  } catch (error) {
    failure = error;
  }
  const tvReturn = await session.detach();
  if (failure) throw withReturn(failure, tvReturn);
  return { ...outcome, tvReturn };
}

/** Write the platform record to the out dir and to the copy capture reads. */
export async function tvProbeCommand({
  config,
  outDir = undefined,
  video = null,
  navigate = null,
  listenKeys = null,
  listenWaitSeconds = null,
  fetch = null,
  exit = false,
  attachPort = null,
  stay = false,
  _note = null,
  _attach = attach,
  _tvProbe = tvProbe,
} = {}) {
  if (!config?.tv?.appid) throw new TvRefusal('tv probe needs a tv block with host and appid in .ui-probe.json');

  const session = await tvSession(config, {
    attachPort,
    returnToApp: restoreEnabled(config, stay),
    _attach,
  });
  let platform;
  let failure = null;
  try {
    // The guided check prints what to press while the window is still open, not after it closes.
    platform = await _tvProbe(session.cdp, {
      video, navigate, listenKeys, listenWaitSeconds, fetch, exit, _note,
      testOrigin: config?.tv?.testOrigin ?? null,
    });
  } catch (error) {
    failure = error;
  }
  const tvReturn = await session.detach();
  if (failure) throw withReturn(failure, tvReturn);

  const dir = outDir ?? config.outDir;
  const record = { ...platform, timings: session.timings };
  writeJson(join(dir, 'platform.json'), record);
  writeJson(platformPath(config.tv.appid), record);
  writeTvReturn(dir, tvReturn);
  return { platform: record, outDir: dir, lines: probeLines(record, dir, tvReturn), tvReturn };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function probeLines(platform, dir, tvReturn = null) {
  const features = platform.features ?? {};
  const navigate = platform.navigate ?? {};
  const video = platform.video ?? {};
  const keys = platform.keys ?? {};
  const listen = platform.listen ?? {};
  const fetched = platform.fetch ?? {};
  const exited = platform.exit;
  const lines = [
    `page: ${features.page?.href ?? 'unread'}`,
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

  if (listen.status === 'measured') {
    const results = listen.results ?? [];
    const got = results.filter((entry) => entry.received).length;
    const missed = results.filter((entry) => !entry.received)
      .map((entry) => `${listenLabel(entry.key)}${registerNote(entry.register)}`);
    lines.push(`listen: ${got}/${results.length} keys received in ${listen.waitSeconds}s each`
      + (missed.length ? ` — not received: ${missed.join(', ')}` : ''));
  } else if (listen.status === 'error') {
    lines.push(`listen: failed (${listen.error})`);
  } else {
    lines.push('listen: skipped');
  }

  if (fetched.status === 'measured') {
    lines.push(`fetch: ${fetched.httpStatus} from ${fetched.url} `
      + `(Access-Control-Allow-Origin ${fetched.allowOrigin ?? 'unreadable'}, `
      + `Access-Control-Allow-Credentials ${fetched.allowCredentials ?? 'unreadable'})`);
  } else if (fetched.status === 'error') {
    lines.push(`fetch: failed (${fetched.error}) — ${fetched.message ?? 'no message'}`);
  } else {
    lines.push('fetch: skipped');
  }

  if (exited) {
    lines.push(`exit: closed ${Boolean(exited.closed)} (${exited.ms ?? '?'} ms, called ${exited.called ?? 'unknown'})`);
  } else {
    lines.push('exit: skipped');
  }

  lines.push(`out: ${dir}`);
  lines.push(platform.verdict);
  const tvLine = tvReturnLine(tvReturn);
  if (tvLine) lines.push(tvLine);
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
    if (error instanceof TvRefusal) return { exitCode: 64, stderr: error.message, tvReturn: error.tvReturn };
    if (error instanceof AttachInconclusive) return { exitCode: 2, stderr: `inconclusive: tv: ${error.message}`, tvReturn: error.tvReturn };
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
    const { result, timings, tvReturn } = await runOnTv({
      doc, config, attachPort: port, stay: rest.includes("--stay"),
      allowWrites: rest.includes("--allow-writes"),
      cookies, baseUrl, source, baseDir, file, _attach, _run,
    });
    return { result, timings, tvReturn };
  });
}

/** `capture --device tv`. */
export function captureTvBranch({ screen, config, rest, getFlag, source = null, baseDir = null, file = null, _attach = attach }) {
  const { port, problem } = portFrom(getFlag, rest);
  if (problem) return { exitCode: 64, stderr: problem };
  return branch(async () => {
    const { digest, outDir, tvReturn } = await captureOnTv({
      screen,
      config,
      attachPort: port,
      stay: rest.includes("--stay"),
      allowWrites: rest.includes("--allow-writes"),
      screenshot: rest.includes("--screenshot"),
      includeBackground: rest.includes("--include-background"),
      outDir: getFlag("--out", rest) ?? undefined,
      source,
      baseDir,
      file,
      _attach,
    });
    return { digest, outDir, tvReturn };
  });
}

/** `tv probe`. */
export async function tvProbeBranch({ config, rest, getFlag, resolveOutDir, out, err }) {
  // `--listen` takes an optional key list; the per-key wait moved to its own flag.
  const listenValue = getFlag("--listen", rest);
  const listenWaitValue = getFlag("--listen-wait", rest);
  let listenKeys = null;
  let listenWaitSeconds = null;
  if (listenValue !== null) {
    try {
      listenKeys = parseListenKeys(listenValue);
    } catch (error) {
      err(error.message);
      return { exitCode: 64 };
    }
  }
  if (rest.includes("--listen")) {
    listenWaitSeconds = listenWaitValue === null ? DEFAULT_LISTEN_WAIT_SECONDS : Number(listenWaitValue);
    if (!Number.isFinite(listenWaitSeconds) || listenWaitSeconds <= 0) {
      err(`--listen-wait needs a positive number of seconds, got ${JSON.stringify(listenWaitValue)}`);
      return { exitCode: 64 };
    }
  } else if (listenWaitValue !== null) {
    err("--listen-wait only means something with --listen");
    return { exitCode: 64 };
  }
  const { port, problem } = portFrom(getFlag, rest);
  if (problem) {
    err(problem);
    return { exitCode: 64 };
  }
  return branch(async () => {
    const { lines, tvReturn } = await tvProbeCommand({
      config,
      outDir: resolveOutDir(config, getFlag("--out", rest)),
      video: getFlag("--video", rest),
      navigate: getFlag("--navigate", rest),
      listenKeys,
      listenWaitSeconds,
      fetch: getFlag("--fetch", rest),
      exit: rest.includes("--exit"),
      attachPort: port,
      stay: rest.includes("--stay"),
      _note: out,
    });
    for (const line of lines) out(line);
    return { tvReturn };
  });
}

