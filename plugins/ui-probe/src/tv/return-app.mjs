// The policy: which app was in front before the widget launched, and how to put it back.
// Detection never fails a run — an unreadable household app must not cost a test slot — so
// it reports `null` for nothing showing and `{ error }` for what it could not read.

import { sleep as realSleep } from "../cdp.mjs";
import { appIds } from "./sdb.mjs";
import { appStatus, launchApp, restBase, RestStatus } from "./rest.mjs";

const BUDGET_MS = 8000; // the whole detection, however many candidates it walks
const APP_TIMEOUT_MS = 5000; // a configured id, and the re-read before a relaunch
const SCAN_TIMEOUT_MS = 2000; // an applist id: a healthy answer takes milliseconds
const SCAN_WIDTH = 4; // applist candidates in flight at once
const VERIFY_MS = 15000; // a relaunched app gets this long to come up visible
const POLL_MS = 500;
const NOT_VISIBLE = "launched, not visible after 15 s";
const OUT_OF_TIME = "detection ran out of time before it found the app in front";
// rest.mjs's timeout message is the only signal that a read used up the time it was given.
const TIMEOUT = /\bdid not answer within \d+ ms$/;

/**
 * The app in front before the widget launched: `{ id, name }`, `null` when nothing was showing
 * (live TV, an HDMI source, the home screen), or `{ error }` when REST would not say. Configured
 * ids are tried first, in order; only when none is visible does the applist scan run.
 */
export async function detectForeground({ config, callSdb, _fetch = fetch, _now = Date.now } = {}) {
  let base;
  try {
    base = restBase(config?.tv?.host);
  } catch (error) {
    return { error: error.message };
  }

  const deadline = _now() + BUDGET_MS;
  const widget = config?.tv?.appid ?? null;
  const tried = new Set();
  const failures = []; // transport problems: one dead id must not hide the app in front

  // `{ found }`, `{}` (not this candidate), `{ error }` (terminal) or `{ failed }` (remembered).
  const readApp = async (id, timeoutMs) => {
    const left = deadline - _now();
    if (left <= 0) return { error: OUT_OF_TIME };
    try {
      const status = await appStatus(base, id, { timeoutMs: Math.min(timeoutMs, left), _fetch });
      return status.visible ? { found: { id, name: status.name } } : {};
    } catch (error) {
      // A 404 is this candidate's answer, not the end of the search: Apple TV's applist id
      // answers 404 on every set. Any other status means the wire itself is refusing us.
      if (error instanceof RestStatus) {
        return error.status === 404 ? {} : { error: `HTTP ${error.status}` };
      }
      return { failed: error.message };
    }
  };

  const configured = (Array.isArray(config?.tv?.returnApps) ? config.tv.returnApps : [])
    .filter((id) => typeof id === "string" && id && id !== widget);
  for (const id of configured) {
    if (tried.has(id)) continue;
    tried.add(id);
    const result = await readApp(id, APP_TIMEOUT_MS);
    if (result.found) return result.found;
    if (result.error) return { error: result.error };
    if (result.failed) failures.push(result.failed);
  }

  let stdout;
  try {
    stdout = (await callSdb(["shell", "0", "applist"]))?.stdout ?? "";
  } catch (error) {
    return { error: `could not list the TV's apps: ${error.message}` };
  }

  // A `.service` id is a background service; REST holds its GET without answering.
  const candidates = appIds(stdout)
    .filter((id) => id !== widget && !id.endsWith(".service") && !tried.has(id));
  for (let index = 0; index < candidates.length; index += SCAN_WIDTH) {
    const batch = candidates.slice(index, index + SCAN_WIDTH);
    for (const id of batch) tried.add(id);
    const results = await Promise.all(batch.map((id) => readApp(id, SCAN_TIMEOUT_MS)));
    const found = results.find((result) => result.found);
    if (found) return found.found;
    const refused = results.find((result) => result.error);
    if (refused) return { error: refused.error };
    for (const result of results) if (result.failed) failures.push(result.failed);
  }

  // Nothing visible: a skipped candidate leaves `nothing was showing` unproven.
  return failures.length ? { error: failures[0] } : null;
}

/**
 * Put `found` back in front. `{ id, name, outcome }`, with the outcome one of `returned`,
 * `already showing`, `launched, not visible after 15 s`, `launched, not confirmed: <why>` or
 * `failed: <why>`. It never throws: the journey's verdict is about the app under test.
 */
export async function returnTo(found, { config, _fetch = fetch, _sleep = realSleep, _now = Date.now } = {}) {
  const id = found.id;
  let name = found.name ?? null;

  let base;
  try {
    base = restBase(config?.tv?.host);
  } catch (error) {
    return { id, name, outcome: `failed: ${error.message}` };
  }

  // Re-read first: the app may have come back by itself while the widget held the screen.
  try {
    const current = await appStatus(base, id, { timeoutMs: APP_TIMEOUT_MS, _fetch });
    if (current.name) name = current.name;
    if (current.visible) return { id, name, outcome: "already showing" };
  } catch { /* an unreadable app is not a visible one; the launch is still worth trying */ }

  try {
    await launchApp(base, id, { launchable: id, widget: config?.tv?.appid ?? null, _fetch, _sleep });
  } catch (error) {
    return { id, name, outcome: `failed: ${error.message}` };
  }

  const deadline = _now() + VERIFY_MS;
  for (;;) {
    const left = deadline - _now();
    if (left <= 0) return { id, name, outcome: NOT_VISIBLE };

    const capped = left < APP_TIMEOUT_MS; // this poll's timeout is the window's remainder
    let status;
    try {
      status = await appStatus(base, id, { timeoutMs: Math.min(APP_TIMEOUT_MS, left), _fetch });
    } catch (error) {
      // A poll cut short by that cap is the window ending, not a wire failure: the live
      // `did not answer within 376 ms` was a 15 s window running out, not a broken set.
      if (capped && TIMEOUT.test(String(error?.message))) return { id, name, outcome: NOT_VISIBLE };
      return { id, name, outcome: `launched, not confirmed: ${error.message}` };
    }
    if (status.name) name = status.name;
    if (status.visible) return { id, name, outcome: "returned" };
    if (_now() >= deadline) return { id, name, outcome: NOT_VISIBLE };

    await _sleep(POLL_MS);
  }
}
