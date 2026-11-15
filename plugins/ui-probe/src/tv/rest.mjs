// The TV's REST wire. Like sdb, every request it may make is named here, and a
// refused call throws before it reaches the network: a read of one application, and a
// launch of the one app this session detected.

import { sleep as realSleep } from "../cdp.mjs";

const REST_PORT = 8001; // Samsung's fixed REST port; tv.host's port belongs to sdb
const GET_TIMEOUT_MS = 5000;
const LAUNCH_TIMEOUT_MS = 5000;
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_RETRY_MS = 1000;

const HOST = /^([^\s/:]+)(?::\d{1,5})?$/;
// The same id shape config.mjs accepts for tv.appid: dotted Tizen ids and store ids.
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROUTE = /^\/api\/v2\/applications\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export class RestRefused extends Error {
  constructor(method, path) {
    super(`REST ${method} ${path} is off the allowlist`);
    this.name = "RestRefused";
    this.method = method;
    this.path = path;
  }
}

/** The TV answered, and the answer was not 200: a 404 for an id is data, not a fault. */
export class RestStatus extends Error {
  constructor(method, path, status) {
    super(`${method} ${path} → HTTP ${status}`);
    this.name = "RestStatus";
    this.status = status;
  }
}

/** `192.0.2.10:26101` -> `http://192.0.2.10:8001`. No new config key: the IP is in tv.host. */
export function restBase(host) {
  const match = HOST.exec(String(host ?? "").trim());
  if (!match) throw new Error(`tv.host ${JSON.stringify(host)} has no address to reach the TV's REST API at`);
  return `http://${match[1]}:${REST_PORT}`;
}

export function allowRest(method, path, { launchable = null, widget = null } = {}) {
  const verb = String(method ?? "").toUpperCase();
  const route = typeof path === "string" ? path : "";
  const match = ROUTE.exec(route);
  if (!match) throw new RestRefused(verb, route);
  if (verb === "GET") return;

  // The only app this tool may launch is the one this session detected — never the widget it
  // launched over, even when a caller hands it that id as `launchable`.
  const id = match[1];
  if (verb !== "POST" || id === widget || id !== launchable) throw new RestRefused(verb, route);
}

function appPath(id, method = "GET") {
  const value = String(id ?? "");
  const path = `/api/v2/applications/${value}`;
  if (!APP_ID.test(value)) throw new RestRefused(method, path);
  return path;
}

/**
 * One request, aborting at `timeoutMs`. The timer is referenced and cleared: an unref'd
 * `AbortSignal.timeout` let Node drain the event loop mid-request (2026-11-13).
 */
async function request(url, { method, timeoutMs, _fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await _fetch(url, { method, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${method} ${url} did not answer within ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The body as JSON, naming the two ways the set fails to give one. */
async function readJson(response, what) {
  const text = String((await response.text()) ?? "");
  if (!text.trim()) throw new Error(`${what} answered an empty body`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} answered a body that is not JSON`);
  }
}

/** `{ id, name, running, visible }` for one app. `visible` is the only foreground signal. */
export async function appStatus(base, id, { timeoutMs = GET_TIMEOUT_MS, _fetch } = {}) {
  const path = appPath(id);
  allowRest("GET", path);

  const response = await request(`${base}${path}`, { method: "GET", timeoutMs, _fetch: _fetch ?? fetch });
  if (!response.ok) throw new RestStatus("GET", path, response.status);

  const what = `GET ${path}`;
  const record = await readJson(response, what);
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${what} answered no application record`);

  return {
    id: typeof record.id === "string" ? record.id : path.split("/").pop(),
    name: typeof record.name === "string" ? record.name : null,
    running: record.running === true,
    visible: record.visible === true,
  };
}

/**
 * POST the launch, retrying an empty or non-JSON answer three times 1 s apart: the first POST
 * after the widget closes sometimes answers nothing before the app starts.
 */
export async function launchApp(base, id, { launchable = null, widget = null, _fetch, _sleep = realSleep } = {}) {
  const path = appPath(id, "POST");
  allowRest("POST", path, { launchable, widget });

  const url = `${base}${path}`;
  const what = `POST ${path}`;
  let problem = null;

  for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await _sleep(LAUNCH_RETRY_MS);
    try {
      const response = await request(url, { method: "POST", timeoutMs: LAUNCH_TIMEOUT_MS, _fetch: _fetch ?? fetch });
      if (!response.ok) throw new RestStatus("POST", path, response.status);
      return await readJson(response, what);
    } catch (error) {
      problem = error;
    }
  }
  throw problem;
}
