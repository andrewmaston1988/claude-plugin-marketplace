// The policy: which app was in front before the widget launched, and how to put it back.
// Detection never fails a run — an unreadable household app must not cost a test slot — so
// it reports `null` for nothing showing and `{ error }` for what it could not read.

import { sleep as realSleep } from "../cdp.mjs";
import { appIds } from "./sdb.mjs";
import { appStatus, launchApp, restBase, RestStatus } from "./rest.mjs";

const BUDGET_MS = 8000; // the whole detection, however many candidates it walks
const GET_TIMEOUT_MS = 5000;
const SCAN_WIDTH = 4; // applist candidates in flight at once
const VERIFY_MS = 5000; // a relaunched app gets this long to come up visible
const POLL_MS = 500;

/**
 * The app in front before the widget launched: `{ id, name }`, `null` when nothing was
 * showing (live TV, an HDMI source, the home screen), or `{ error }` when REST would not say.
 *
 * The configured ids are tried first, in order: that is the only route to an app whose
 * applist id REST rejects (Apple TV). Only when none of them is visible does the applist
 * scan run, and it never re-tries an id or the widget's own.
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

  const readApp = async (id) => {
    const left = deadline - _now();
    if (left <= 0) return { error: "detection ran out of time before it found the app in front" };
    try {
      const status = await appStatus(base, id, { timeoutMs: Math.min(GET_TIMEOUT_MS, left), _fetch });
      return status.visible ? { found: { id, name: status.name } } : {};
    } catch (error) {
      // A 404 is this candidate's answer, not the end of the search: Apple TV's applist id
      // answers 404 on every set. Anything else is the wire itself failing.
      return error instanceof RestStatus ? {} : { error: error.message };
    }
  };

  const configured = (Array.isArray(config?.tv?.returnApps) ? config.tv.returnApps : [])
    .filter((id) => typeof id === "string" && id && id !== widget);
  for (const id of configured) {
    if (tried.has(id)) continue;
    tried.add(id);
    const result = await readApp(id);
    if (result.found) return result.found;
    if (result.error) return { error: result.error };
  }

  let stdout;
  try {
    stdout = (await callSdb(["shell", "0", "applist"]))?.stdout ?? "";
  } catch (error) {
    return { error: `could not list the TV's apps: ${error.message}` };
  }

  const candidates = appIds(stdout).filter((id) => id !== widget && !tried.has(id));
  for (let index = 0; index < candidates.length; index += SCAN_WIDTH) {
    const batch = candidates.slice(index, index + SCAN_WIDTH);
    for (const id of batch) tried.add(id);
    const results = await Promise.all(batch.map(readApp));
    const found = results.find((result) => result.found);
    if (found) return found.found;
    const failed = results.find((result) => result.error);
    if (failed) return { error: failed.error };
  }

  return null;
}

/**
 * Put `found` back in front. `{ id, name, outcome }`, with the outcome one of `returned`,
 * `already showing`, `launched, not visible after 5 s`, `launched, not confirmed: <why>` or
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
    const current = await appStatus(base, id, { timeoutMs: GET_TIMEOUT_MS, _fetch });
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
    if (left <= 0) return { id, name, outcome: "launched, not visible after 5 s" };

    let status;
    try {
      status = await appStatus(base, id, { timeoutMs: Math.min(GET_TIMEOUT_MS, left), _fetch });
    } catch (error) {
      return { id, name, outcome: `launched, not confirmed: ${error.message}` };
    }
    if (status.name) name = status.name;
    if (status.visible) return { id, name, outcome: "returned" };
    if (_now() >= deadline) return { id, name, outcome: "launched, not visible after 5 s" };

    await _sleep(POLL_MS);
  }
}
