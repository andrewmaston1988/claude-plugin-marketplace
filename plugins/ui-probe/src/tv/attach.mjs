// Attach to the TV's inspector: close the app, launch it under `sdb debug`, forward
// the dynamic port it prints, then take the first page target. Port 9222 is never assumed.

import { connect, sleep } from "../cdp.mjs";
import { listedDevices, packageId, parseDebugPort, sdb } from "./sdb.mjs";

const DEBUG_TIMEOUT_MS = 35000; // a second debug launch while the app runs hangs ~30 s
const TARGET_ATTEMPTS = 20;
const TARGET_POLL_MS = 500;

export class AttachInconclusive extends Error {
  constructor(message) {
    super(message);
    this.name = "AttachInconclusive";
  }
}

export async function attach(config, options = {}) {
  const {
    attachPort = null,
    _connect = connect,
    _fetch = fetch,
    _sleep = sleep,
    _now = Date.now,
    timeoutMs = DEBUG_TIMEOUT_MS,
  } = options;
  const tv = config?.tv;
  if (!tv?.host || !tv?.appid) {
    throw new Error("attaching to the TV needs tv.host and tv.appid in .ui-probe.json");
  }

  const callSdb = options._sdb ?? ((args, callOptions) => sdb(args, { config, ...callOptions }));
  const pkgid = packageId(tv.appid);
  const joined = attachPort == null ? null : Number(attachPort);

  let port = joined;
  let launched = false;
  let relaunchMs = null;
  const started = _now();

  try {
    if (joined === null) {
      await ensureDevice(tv.host, callSdb, timeoutMs);
      await closeApp(pkgid, callSdb, timeoutMs);

      const debug = await callSdb(["shell", "0", "debug", tv.appid], { timeoutMs });
      port = parseDebugPort(`${debug.stdout ?? ""}${debug.stderr ?? ""}`);
      if (port === null) {
        throw new AttachInconclusive(
          `sdb shell 0 debug ${tv.appid} printed no port — the app may still be running: press EXIT on the remote, then re-run`,
        );
      }
      launched = true;
      await callSdb(["forward", `tcp:${port}`, `tcp:${port}`], { timeoutMs });
      // A relaunch costs seconds; this is how many the caller can expect to spend again.
      relaunchMs = _now() - started;
    }

    const target = await pageTarget(port, { _fetch, _sleep });
    const protocol = await fetchProtocol(port, _fetch);
    const cdp = await _connect(target.webSocketDebuggerUrl);
    let detached = false;

    return {
      cdp,
      port,
      protocol,
      timings: { attachMs: _now() - started, relaunchMs },
      async detach() {
        if (detached) return;
        detached = true;
        try { cdp.close(); } catch { /* the app may have exited already */ }
        if (launched) await quietly(() => callSdb(["shell", "0", "kill", pkgid], { timeoutMs }));
        await quietly(() => callSdb(["forward", "--remove", `tcp:${port}`], { timeoutMs }));
      },
    };
  } catch (error) {
    if (launched) await quietly(() => callSdb(["shell", "0", "kill", pkgid], { timeoutMs }));
    if (port !== null) await quietly(() => callSdb(["forward", "--remove", `tcp:${port}`], { timeoutMs }));
    throw error;
  }
}

/** sdb lists nothing until it has been told the TV's address. */
async function ensureDevice(host, callSdb, timeoutMs) {
  if (listedDevices((await callSdb(["devices"], { timeoutMs })).stdout).includes(host)) return;

  await callSdb(["connect", host], { timeoutMs });
  if (listedDevices((await callSdb(["devices"], { timeoutMs })).stdout).includes(host)) return;

  throw new AttachInconclusive(`no TV at ${host}: developer mode is off or has expired, or the TV is off`);
}

async function closeApp(pkgid, callSdb, timeoutMs) {
  const result = await callSdb(["shell", "0", "kill", pkgid], { timeoutMs });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.code !== 0 || /failed/i.test(text)) {
    throw new AttachInconclusive(
      `could not close ${pkgid} (${text || `exit ${result.code}`}) — press EXIT on the remote, then re-run`,
    );
  }
}

async function pageTarget(port, { _fetch, _sleep }) {
  const url = `http://127.0.0.1:${port}/json/list`;
  let problem = `GET ${url} did not answer`;

  for (let attempt = 0; attempt < TARGET_ATTEMPTS; attempt += 1) {
    try {
      const response = await _fetch(url);
      if (!response.ok) {
        problem = `GET ${url} → HTTP ${response.status}`;
      } else {
        const targets = await response.json();
        const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (target) return target;
        problem = `no page target in ${url}`;
      }
    } catch (error) {
      problem = `${url}: ${error.message}`;
    }
    await _sleep(TARGET_POLL_MS);
  }
  throw new AttachInconclusive(problem);
}

/** The guard picks its interception from this; a target that will not report it is not fatal. */
async function fetchProtocol(port, _fetch) {
  try {
    const response = await _fetch(`http://127.0.0.1:${port}/json/protocol`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function quietly(run) {
  try {
    await run();
  } catch { /* cleanup must not mask the failure that caused it */ }
}
