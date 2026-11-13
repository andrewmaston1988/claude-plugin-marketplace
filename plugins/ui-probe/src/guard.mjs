import { evaluate } from "./cdp.mjs";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isWrite(method) {
  return !READ_METHODS.has(String(method || "").toUpperCase());
}

/**
 * Fail every write the page tries to send, at the request stage. Reads pass through untouched.
 * Under TV scope `--allow-writes` is not a blank cheque: only writes to `testOrigin` continue.
 * Returns the shared `blocked` list so a caller can report what was stopped.
 */
export async function installFetchGuard(cdp, {
  allowWrites = false,
  blocked = [],
  testOrigin = null,
  tvScope = false,
} = {}) {
  const testOriginValue = testOrigin ? originOf(testOrigin) : null;
  const allowedWrite = (url) => {
    if (!allowWrites) return false;
    if (!tvScope) return true;
    return testOriginValue != null && originOf(url) === testOriginValue;
  };
  if (allowWrites && !tvScope) return { blocked, uninstall: async () => {} };

  const off = cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
    try {
      if (isWrite(request.method) && !allowedWrite(request.url)) {
        blocked.push({ method: request.method, url: request.url, at: Date.now() });
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      } else {
        await cdp.send("Fetch.continueRequest", { requestId });
      }
    } catch { /* the page may have navigated away mid-request */ }
  });

  try {
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  } catch (error) {
    off();
    throw error;
  }

  return {
    blocked,
    async uninstall() {
      off();
      try { await cdp.send("Fetch.disable"); } catch { /* the socket is already gone */ }
    },
  };
}

/** TV scope follows the target device as well as the file's declared backend. */
export function inTvScope({ backend = null, device = null } = {}) {
  return backend === "tv" || device === "tv";
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function domainsOf(protocol) {
  if (!protocol) return null;
  if (Array.isArray(protocol)) return protocol;
  return Array.isArray(protocol.domains) ? protocol.domains : [];
}

/**
 * Which interception this target offers. Chromium 69 on the TV has no Fetch domain, so the guard
 * falls back to Network interception; null means neither is available and the caller must refuse.
 */
export function interceptionKind(protocol) {
  const domains = domainsOf(protocol);
  if (!domains) return "fetch";
  if (domains.some((domain) => domain?.domain === "Fetch")) return "fetch";
  const network = domains.find((domain) => domain?.domain === "Network");
  return network?.commands?.some((command) => command?.name === "setRequestInterception") ? "network" : null;
}

/**
 * Fail every write at the request stage over Network interception (pre-Fetch Chromium). Under TV
 * scope a write is only continued to `testOrigin`; every other write is blocked and recorded, so
 * an allowed run cannot stray to production.
 */
export async function installNetworkGuard(cdp, {
  allowWrites = false,
  blocked = [],
  testOrigin = null,
  tvScope = false,
} = {}) {
  const testOriginValue = testOrigin ? originOf(testOrigin) : null;
  const allowedWrite = (url) => {
    if (!allowWrites) return false;
    if (!tvScope) return true;
    return testOriginValue != null && originOf(url) === testOriginValue;
  };

  const off = cdp.on("Network.requestIntercepted", async ({ interceptionId, request }) => {
    try {
      if (isWrite(request?.method) && !allowedWrite(request?.url)) {
        blocked.push({ method: request.method, url: request.url, at: Date.now() });
        await cdp.send("Network.continueInterceptedRequest", { interceptionId, errorReason: "BlockedByClient" });
      } else {
        await cdp.send("Network.continueInterceptedRequest", { interceptionId });
      }
    } catch { /* the page may have navigated away mid-request */ }
  });

  try {
    await cdp.send("Network.enable");
    await cdp.send("Network.setRequestInterception", {
      patterns: [{ urlPattern: "*", interceptionStage: "Request" }],
    });
  } catch (error) {
    off();
    throw error;
  }

  return {
    blocked,
    async uninstall() {
      off();
      try { await cdp.send("Network.setRequestInterception", { patterns: [] }); } catch { /* the socket is already gone */ }
    },
  };
}

/**
 * Pick the guard the target's protocol can run. A null protocol means the browser path, where the
 * Fetch guard is known to work.
 */
export async function installGuard(cdp, protocol, options = {}) {
  const kind = interceptionKind(protocol);
  if (kind === "fetch") return installFetchGuard(cdp, options);
  // Neither domain: the caller's policy decides whether the run may proceed at all.
  if (kind === null) return { blocked: options.blocked ?? [], uninstall: async () => {} };
  return installNetworkGuard(cdp, options);
}

function openUrl(step) {
  if (typeof step === "string") return step;
  if (!step || typeof step !== "object") return null;
  const inner = step.open ?? step;
  if (typeof inner === "string") return inner;
  return inner?.url ?? null;
}

/**
 * Why a TV run cannot start, or null when it can. Without interception the only safe shape is a
 * fully allowed run pinned to the test origin; with it, writes are still scoped there.
 */
export function tvWritePolicy({
  tvScope = false,
  allowWrites = false,
  testOrigin = null,
  hasInterception = false,
  opens = [],
} = {}) {
  if (!tvScope) return null;

  const testOriginValue = testOrigin ? originOf(testOrigin) : null;
  if (allowWrites && testOriginValue == null) {
    return "--allow-writes needs tv.testOrigin set: on the TV it only lets through writes to the test origin";
  }
  if (hasInterception) return null;
  if (!allowWrites) {
    return "this TV target offers no request interception, so a run needs --allow-writes";
  }
  for (const step of opens) {
    const url = openUrl(step);
    if (originOf(url) !== testOriginValue) {
      return `open ${url ?? "(none)"} is outside tv.testOrigin ${testOriginValue}: this TV target offers no request interception, so every open must be on the test origin`;
    }
  }
  return null;
}

// The element's own htmx verb beats its formmethod, which beats the form's htmx verb, which beats
// the form's method. A link navigates, so it is never a write whatever form encloses it.
const ACTION_JS = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false };
  const VERBS = ["post", "put", "patch", "delete"];
  const htmx = (node) => {
    for (const verb of VERBS) {
      const url = node.getAttribute("hx-" + verb);
      if (url != null) return { method: verb.toUpperCase(), url };
    }
    return null;
  };
  const own = htmx(el);
  if (own) return { found: true, ...own };
  if (el.tagName === "A") return { found: true, method: "GET", url: el.getAttribute("href") };
  const formmethod = el.getAttribute("formmethod");
  if (formmethod) {
    const form = el.closest("form");
    return { found: true, method: formmethod.toUpperCase(), url: form && form.getAttribute("action") };
  }
  const form = el.closest("form");
  if (!form) return { found: true, method: "GET", url: el.getAttribute("href") };
  return { found: true, ...(htmx(form) || {
    method: (form.getAttribute("method") || "GET").toUpperCase(),
    url: form.getAttribute("action"),
  }) };
})()`;

/**
 * Read the form method the target would submit with, so a click can be refused before any input
 * is dispatched. `allowed` is false for anything that is not a read.
 */
export async function actionAllowed(cdp, target) {
  const result = await evaluate(cdp, ACTION_JS(target));
  if (!result.found) return { allowed: false, found: false, method: null, url: null };
  return {
    allowed: !isWrite(result.method),
    found: true,
    method: result.method,
    url: result.url ?? null,
  };
}
