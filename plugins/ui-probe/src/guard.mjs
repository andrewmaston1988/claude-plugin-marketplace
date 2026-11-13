import { evaluate } from "./cdp.mjs";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isWrite(method) {
  return !READ_METHODS.has(String(method || "").toUpperCase());
}

/**
 * Fail every write the page tries to send, at the request stage. Reads pass through untouched.
 * Returns the shared `blocked` list so a caller can report what was stopped.
 */
export function installFetchGuard(cdp, { allowWrites = false, blocked = [] } = {}) {
  if (allowWrites) return { blocked, uninstall: async () => {} };

  const off = cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
    try {
      if (isWrite(request.method)) {
        blocked.push({ method: request.method, url: request.url, at: Date.now() });
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      } else {
        await cdp.send("Fetch.continueRequest", { requestId });
      }
    } catch { /* the page may have navigated away mid-request */ }
  });

  const enabled = cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  return {
    blocked,
    async uninstall() {
      off();
      try { await enabled; await cdp.send("Fetch.disable"); } catch { /* the socket is already gone */ }
    },
  };
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
