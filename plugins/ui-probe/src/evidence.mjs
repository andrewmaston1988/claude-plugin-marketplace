// The page's console and its traffic, recorded once for capture and again for a run. One shape
// for both, so a run's console.json reads exactly like a capture's.

export function networkLog(requests, blocked) {
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

/**
 * Enable the three domains and attach the listeners. `Log` is optional: older Chromium lacks it.
 * `stop()` removes every listener, whichever way the run ends.
 */
export async function recordEvidence(cdp) {
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  try { await cdp.send("Log.enable"); } catch { /* Log is optional on older Chromium */ }
  const events = { requests: new Map(), console: [] };
  const offs = listen(cdp, events);
  return {
    events,
    stop() { for (const off of offs) off(); },
  };
}
