// Zero-dependency CDP client over Node's built-in WebSocket.

const TARGET_POLL_MS = 100;
const TARGET_POLLS = 100;
const DEFAULT_TIMEOUT_MS = 30000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageTarget(port, { _fetch, _sleep }) {
  const url = `http://127.0.0.1:${port}/json/list`;
  return poll(async () => {
    const list = await (await _fetch(url)).json();
    return list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  }, `no page target in ${url}`, _sleep);
}

async function poll(attempt, failure, _sleep) {
  for (let i = 0; i < TARGET_POLLS; i++) {
    try {
      const value = await attempt();
      if (value) return value;
    } catch { /* the browser is still starting */ }
    await _sleep(TARGET_POLL_MS);
  }
  throw new Error(failure);
}

/**
 * Open a CDP connection. A port attaches to its first `page` target; a `ws://` URL is used as-is,
 * which is how the browser-level socket is made for `Browser.close`.
 */
export function connect(target, {
  _WebSocket = WebSocket,
  _fetch = fetch,
  _sleep = sleep,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;

    const open = (wsUrl) => {
      const ws = new _WebSocket(wsUrl);
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id == null) {
          for (const fn of listeners.get(message.method) || []) {
            try { fn(message.params); } catch { /* a listener must never kill the socket */ }
          }
          return;
        }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      });
      ws.addEventListener("error", () => reject(new Error(`websocket failed: ${wsUrl}`)));
      // A dead browser closes the socket; without this every pending call hangs the probe.
      ws.addEventListener("close", () => {
        const error = new Error(`websocket closed: ${wsUrl}`);
        reject(error);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        for (const fns of listeners.values()) fns.length = 0;
      });
      ws.addEventListener("open", () => resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => { clearTimeout(timer); res(value); },
              reject: (error) => { clearTimeout(timer); rej(error); },
            });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              clearTimeout(timer);
              rej(error);
            }
          });
        },
        on(method, fn) {
          if (!listeners.has(method)) listeners.set(method, []);
          listeners.get(method).push(fn);
          return () => {
            const fns = listeners.get(method) || [];
            const i = fns.indexOf(fn);
            if (i >= 0) fns.splice(i, 1);
          };
        },
        close() { try { ws.close(); } catch { /* already gone */ } },
      }));
    };

    if (typeof target === "number") {
      pageTarget(target, { _fetch, _sleep }).then((found) => open(found.webSocketDebuggerUrl), reject);
    } else {
      open(target);
    }
  });
}

export async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate threw");
  return result.result.value;
}
