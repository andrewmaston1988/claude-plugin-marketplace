import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
export const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const getJson = async (url) => (await fetch(url)).json();

export function findBrowser() {
  const i = process.argv.indexOf("--browser");
  const explicit = (i >= 0 ? process.argv[i + 1] : null) || process.env.SWARM_PROBE_BROWSER;
  for (const candidate of [explicit, EDGE, ...CHROME].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["chrome", "google-chrome", "chromium"]) {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
    const first = (result.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && existsSync(first)) return first;
  }
  throw new Error("no browser found — pass --browser <path>");
}

export function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let nextId = 1;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id != null && waiting.get(message.id);
      if (!waiter) return;
      waiting.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    });
    ws.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)));
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((res, rej) => {
          waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { try { ws.close(); } catch {} },
    }));
  });
}

export async function devtoolsPort(userDataDir, child) {
  const file = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (port) return port;
    }
    if (child.exitCode != null) throw new Error(`browser exited early (code ${child.exitCode})`);
    await sleep(100);
  }
  throw new Error("browser never wrote DevToolsActivePort");
}

export async function pageTarget(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = list.find((item) => item.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await sleep(100);
  }
  throw new Error("no page target appeared");
}

export async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate threw");
  return result.result.value;
}