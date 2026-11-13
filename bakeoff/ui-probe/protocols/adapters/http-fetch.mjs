// HTTP contender: plain `fetch` + a hand-built agent-readable transcript.
//
// The probe sends GET only, to one host/port/path set named by the policy, and never follows
// a redirect (a 30x is recorded, not chased). Cookie / Authorization / Set-Cookie values are
// replaced before the transcript exists, so a transcript is safe to hand to an agent or
// commit as an artifact.

import { httpPolicy, InputError } from "../allow.mjs";
import { redactHeaders, redactText } from "../redact.mjs";

export const BODY_LIMIT = 512;

/** fetch gives Headers; accept a plain iterable too so a fake can stand in. */
function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === "function") return [...headers.entries()];
  return Object.entries(headers);
}

const SELECTED = [
  "content-type",
  "content-length",
  "location",
  "cache-control",
  "date",
  "server",
  "set-cookie",
  "cookie",
  "authorization",
];

function selectedHeaders(headers) {
  const all = redactHeaders(headerEntries(headers));
  return Object.fromEntries(Object.entries(all).filter(([name]) => SELECTED.includes(name)));
}

function truncateBody(body) {
  const text = String(body ?? "");
  if (text.length <= BODY_LIMIT) return { text, truncated: 0, total: text.length };
  return { text: text.slice(0, BODY_LIMIT), truncated: text.length - BODY_LIMIT, total: text.length };
}

export function renderTranscript({ method, url, requestHeaders, status, statusText, headers, body, ms, secrets }) {
  const lines = [];
  lines.push(`${method} ${url}`);
  for (const [name, value] of Object.entries(redactHeaders(Object.entries(requestHeaders ?? {})))) {
    lines.push(`> ${name}: ${value}`);
  }
  lines.push(`< HTTP ${status} ${statusText ?? ""}`.trimEnd());
  for (const [name, value] of Object.entries(selectedHeaders(headers))) {
    lines.push(`< ${name}: ${value}`);
  }
  const cut = truncateBody(body);
  lines.push(`< body ${cut.total} chars${cut.truncated ? `, showing ${BODY_LIMIT} (+${cut.truncated} truncated)` : ""}:`);
  lines.push(redactText(cut.text, secrets));
  lines.push(`# ${Number(ms).toFixed(1)} ms`);
  return lines.join("\n");
}

/**
 * @param {object} deps
 * @param {Function} deps.fetchImpl  injected at call time (never defaulted at definition time)
 * @param {object}   deps.target     { host, port, origin }
 * @param {object}   [deps.headers]  request headers for an authenticated read (fixture cookie)
 * @param {string[]} [deps.secrets]  values that must never reach a transcript
 */
export function createHttpAdapter({ fetchImpl, target, headers = {}, secrets = [], timeoutMs = 5000, clock = () => performance.now() }) {
  const policy = httpPolicy({
    host: target.host,
    ports: [target.port],
    paths: ["/api/scan-status", "/api/does-not-exist"],
  });

  async function send({ method = "GET", path, headers: requestHeaders = {} }) {
    const url = `${target.origin}${path}`;
    if (!policy.allow({ method, url })) {
      throw new InputError(`http: ${method} ${url} is off the allowlist (${policy.describe()})`);
    }
    const started = clock();
    const response = await fetchImpl(url, {
      method,
      headers: requestHeaders,
      redirect: "manual", // a 30x is evidence, not an invitation
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    const ms = clock() - started;
    const transcript = renderTranscript({
      method,
      url,
      requestHeaders,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
      ms,
      secrets,
    });
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* a non-JSON body is still a valid observation */
    }
    return {
      transcript,
      meta: { status: response.status, headers: Object.fromEntries(headerEntries(response.headers)), body, json },
    };
  }

  return {
    id: "http-fetch",
    label: "fetch (Node 24 global)",
    tasks: ["http.scan-status", "http.scan-status-anon", "http.missing"],
    guard: {
      mechanism: "method/host/port/path allowlist + redirect:manual, enforced before fetch()",
      describe: () => policy.describe(),
      bite: async () => {
        try {
          await send({ method: "POST", path: "/api/scan-status" });
          return { attempt: "POST /api/scan-status", blocked: false, message: "the POST reached fetch()" };
        } catch (err) {
          return { attempt: "POST /api/scan-status", blocked: err instanceof InputError, message: err.message };
        }
      },
    },
    async probe(task) {
      switch (task.id) {
        case "http.scan-status":
          return send({ method: "GET", path: "/api/scan-status", headers });
        case "http.scan-status-anon":
          return send({ method: "GET", path: "/api/scan-status" });
        case "http.missing":
          return send({ method: "GET", path: "/api/does-not-exist" });
        default:
          throw new InputError(`http: no probe for ${task.id}`);
      }
    },
  };
}
