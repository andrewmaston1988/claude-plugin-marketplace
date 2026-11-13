// Contender (e): swarm's zero-dependency `cdp.mjs` — a hand-rolled DevTools client over the
// built-in WebSocket, plus `Accessibility.getFullAXTree` as the observation.
//
// The AX tree arrives as a flat node list with no formatting, so this adapter carries the lane's
// own ~30-line serialiser. That is part of what (e) costs: any byte figure below is the protocol
// plus this formatter, not a protocol figure alone.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, devtoolsPort, evaluate, findBrowser, pageTarget, sleep } from "../lib/cdp.mjs";
import { round } from "../lib/harness.mjs";

const EXTERNAL_BLOCK = ["*://image.tmdb.org/*", "*://cdnjs.cloudflare.com/*"];
const READY_POLL_MS = 50;
const SELF_CLOSING = new Set(["none", "generic", "presentation", "InlineTextBox"]);

export const name = "cdp";
export const version = "swarm/lib/cdp.mjs (99 lines, zero npm dependencies)";
export const install = {
  kind: "no dependency: node:child_process + global WebSocket + a system Chrome/Edge",
  package: null,
  version,
  browsersPath: "(system browser)",
  browsers: "the operator's installed Chrome/Edge",
  dependencyCount: 0,
};

export async function create({ viewport, touch = false, cookie = null }) {
  const exe = findBrowser();

  const profile = mkdtempSync(join(tmpdir(), "ui-probe-cdp-profile-"));
  const child = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
    "--disable-background-networking", "--disable-sync",
    `--window-size=${viewport.width},${viewport.height}`, "about:blank",
  ], { stdio: "ignore" });
  const pid = child.pid;

  const port = await devtoolsPort(profile, child);
  const versionInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserWs = await connect(versionInfo.webSocketDebuggerUrl);
  const target = await pageTarget(port);
  const client = await connect(target.webSocketDebuggerUrl);

  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  await client.send("Network.setBlockedURLs", { urls: EXTERNAL_BLOCK });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
    mobile: touch,
  });
  if (touch) await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  if (cookie) {
    await client.send("Network.setCookie", {
      name: cookie.cookie_name, value: cookie.cookie_value,
      domain: "127.0.0.1", path: "/", httpOnly: false,
    });
  }

  const session = {
    tool: name,
    raw: { client, browserWs, pid },
    blocked: [],
    async goto(url, ready, timeoutMs = 15000) {
      const t0 = performance.now();
      await client.send("Page.navigate", { url });
      if (ready) await waitFor(ready, timeoutMs);
      return round(performance.now() - t0, 2);
    },
    async waitFor(expr, timeoutMs = 15000) { return waitFor(expr, timeoutMs); },
    async eval(expr) { return evaluate(client, expr); },
    async mouseTo(x, y) {
      // A real mouse event with pointerType mouse — the same path a user's mouse takes.
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse", button: "none" });
    },
    async clickAt(x, y) {
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, pointerType: "mouse" });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, pointerType: "mouse" });
    },
    async tapAt(x, y) {
      const point = [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
      await sleep(30);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    },
    async hoverSelector(sel) {
      const box = await boxOf(sel);
      await session.mouseTo(box.x + box.w / 2, box.y + box.h / 2);
    },
    async clickSelector(sel) {
      const box = await boxOf(sel);
      await session.clickAt(box.x + box.w / 2, box.y + box.h / 2);
    },
    /** `Accessibility.getFullAXTree`, serialised. The tool's own observation path. */
    async observe() { return serialise(await client.send("Accessibility.getFullAXTree")); },
    /**
     * A scoped read in CDP's own terms: DOM → backendNodeId → the node's AX id, then that node's
     * subtree out of the full tree. `Accessibility.getPartialAXTree` alone returns the node and its
     * ancestors but not its descendants, so a partial-only read of a card came back with no badge
     * and no buttons.
     */
    async observeSelector(sel) {
      const { root } = await client.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
      if (!nodeId) return "";
      const { node } = await client.send("DOM.describeNode", { nodeId });
      const partial = await client.send("Accessibility.getPartialAXTree", {
        backendNodeId: node.backendNodeId, fetchRelatives: false,
      });
      const rootId = partial.nodes?.[0]?.nodeId;
      if (!rootId) return "";
      const { nodes } = await client.send("Accessibility.getFullAXTree");
      return serialise(subtree(nodes, rootId), rootId);
    },
    async screenshot(file) {
      const { data } = await client.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    /** RQ9's network layer, in CDP's own idiom: `Fetch` interception at the request stage. */
    async guardNetwork(decision) {
      await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      session._unfetch = client.on("Fetch.requestPaused", async ({ requestId, request }) => {
        const verdict = decision({ method: request.method, url: request.url });
        try {
          if (verdict === "abort") {
            session.blocked.push({ method: request.method, url: request.url, at: Date.now() });
            await client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
          } else {
            await client.send("Fetch.continueRequest", { requestId });
          }
        } catch { /* the page may have gone */ }
      });
    },
    async unguardNetwork() {
      session._unfetch?.();
      await client.send("Fetch.disable");
    },
    /** CDP's temporal capture: a JPEG screencast is the filmstrip. */
    async screencastStart(sink) {
      session._frames = [];
      session._offFrame = client.on("Page.screencastFrame", async ({ data, sessionId, timestamp }) => {
        session._frames.push({ at: timestamp, bytes: Math.floor(data.length * 3 / 4) });
        sink?.(data, timestamp);
        try { await client.send("Page.screencastFrameAck", { sessionId }); } catch {}
      });
      await client.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
    },
    async screencastStop() {
      await client.send("Page.stopScreencast");
      session._offFrame?.();
      return session._frames || [];
    },
    async close() {
      // The launcher stub already exited, so the only handle on the real browser is the socket.
      // Browser.close, then wait for the debugging port to stop answering — never a name-based kill.
      try { await browserWs.send("Browser.close"); } catch {}
      browserWs.close();
      client.close();
      let dead = false;
      for (let i = 0; i < 40; i++) {
        try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) }); }
        catch { dead = true; break; }
        await sleep(150);
      }
      if (!dead) console.warn(`cdp: browser on port ${port} still answering after Browser.close`);
      for (const dir of [profile]) {
        for (let i = 0; i < 5; i++) {
          try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(200); }
        }
      }
    },
  };

  async function waitFor(expr, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await evaluate(client, expr)) return true; } catch {}
      await sleep(READY_POLL_MS);
    }
    throw new Error(`cdp: timed out waiting for ${expr.slice(0, 60)}`);
  }

  async function boxOf(sel) {
    return evaluate(client, `(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null; const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  }

  return session;
}

function subtree(nodes, rootId) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const children = new Map();
  for (const n of nodes) {
    const parent = n.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n);
  }
  const out = [];
  const walk = (id) => {
    const node = byId.get(id);
    if (!node) return;
    out.push(node);
    for (const c of children.get(id) || []) walk(c.nodeId);
  };
  walk(rootId);
  return { nodes: out };
}

/**
 * AX tree -> agent text. `role "name"` per line, indented by depth, `ignored` and structural
 * nodes dropped, text nodes folded in as their name. A scoped read uses
 * `Accessibility.getPartialAXTree` and runs through here unchanged.
 */
export function serialise(tree, rootId = null) {
  const nodes = tree.nodes || [];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const children = new Map();
  for (const n of nodes) {
    const parent = n.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n);
  }
  const root = (rootId && byId.get(rootId))
    || nodes.find((n) => (n.parentId ?? null) === null)
    || nodes[0];
  if (!root) return "";
  const lines = [];
  const label = (n) => {
    const role = n.role?.value || "";
    const name = n.name?.value || "";
    const value = n.value?.value;
    let out = `${role}${name ? ` "${name}"` : ""}`;
    if (value != null && value !== "") out += ` = ${JSON.stringify(value)}`;
    return out;
  };
  const walk = (n, depth) => {
    const role = n.role?.value || "";
    const keep = !n.ignored && role && !SELF_CLOSING.has(role);
    if (keep) lines.push(`${"  ".repeat(depth)}${label(n)}`);
    const next = keep ? depth + 1 : depth;
    for (const c of children.get(n.nodeId) || []) walk(c, next);
  };
  walk(root, 0);
  return lines.join("\n");
}
