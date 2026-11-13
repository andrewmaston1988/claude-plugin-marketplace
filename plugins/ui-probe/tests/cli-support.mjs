// Shared CLI harness: every invocation is a real child process, so the exit code and the
// loaded-module set are the ones a user gets.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
export const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
export const BIN = path.join(PLUGIN, "bin", "ui-probe.mjs");

// Async spawn, never spawnSync: the fixture server lives in this process's event loop, and a
// synchronous child would block it until every baseUrl check timed out.
export async function probe(args, { cwd = PLUGIN, hook = false, log = null, env: overrides = null } = {}) {
  // With a loader registered, Windows entry specifiers must be relative to the plugin root:
  // raw `C:\` paths die on ERR_UNSUPPORTED_ESM_URL_SCHEME and file:// URLs get cwd-joined.
  // Hook probes therefore run from PLUGIN and take --config explicitly.
  const argv = hook
    ? ["--import", "./tests/module-hook.mjs", "./bin/ui-probe.mjs", ...args]
    : [BIN, ...args];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // A null override deletes the variable: that is how a test hides sdb from findSdb.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  if (log) env.UI_PROBE_MODULE_LOG = log;
  try {
    const { stdout, stderr } = await execFile(process.execPath, argv, {
      cwd: hook ? PLUGIN : cwd,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (e) {
    if (typeof e.code !== "number") throw e;
    return { status: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export function scratchConfig(dir, config) {
  writeFileSync(path.join(dir, ".ui-probe.json"), JSON.stringify(config, null, 2));
}

export function scratchDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// A CDP target the CLI can attach to with --attach-port: /json/list, /json/protocol and a
// WebSocket that answers CDP calls. Only reachable over loopback, never the set.
export async function startCdpStub({ protocol, evaluate = () => null, onEvaluated = null } = {}) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/json/list") {
      const { port } = server.address();
      return json([{ id: "p1", type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/p1` }]);
    }
    if (req.url === "/json/protocol") return json(protocol ?? { domains: [] });
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A child that exits mid-frame resets the socket; that is the run ending, not a test failure.
    socket.on("error", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = readFrame(pending);
        if (!frame) return;
        pending = frame.rest;
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.text);
        if (message.id == null) continue;
        const expression = message.params?.expression ?? "";
        const value = message.method === "Runtime.evaluate"
          ? { result: { result: { value: evaluate(expression) } } }
          : { result: {} };
        socket.write(encodeFrame(JSON.stringify({ id: message.id, ...value })));
        if (message.method === "Runtime.evaluate" && onEvaluated?.(expression) === "close") {
          socket.end();
          return;
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// What a TV page reports when it has no tizen at all: the shape the CLI's probe tests answer with.
export const TV_FEATURES = {
  userAgent: "stub",
  tizen: "undefined",
  tvinputdevice: "undefined",
  application: "undefined",
  webapis: "undefined",
  IntersectionObserver: false,
  ResizeObserver: false,
  registerKeyPresent: false,
  currentAppPresent: false,
  flexGap: true,
  aspectRatio: true,
  backdropFilter: false,
};

// A CDP target that answers the guided listen: it records each banner's key, and answers that
// key's press from `pressed`. Everything else is a settled page with no tizen.
export async function startGuidedListenStub({ settledPage, features = TV_FEATURES, pressed = {} } = {}) {
  const prompts = [];
  let current = null;
  const stub = await startCdpStub({
    protocol: { domains: [{ domain: "Page" }, { domain: "Network" }] },
    evaluate: (expression) => {
      const js = String(expression);
      if (js.includes("document.readyState")) return settledPage;
      if (js.includes("IntersectionObserver")) return features;
      const prompt = /Press (.+?) on the remote/.exec(js);
      if (prompt) {
        current = prompt[1];
        prompts.push(current);
        return true;
      }
      if (js.includes("state.log.slice")) return { events: pressed[current] ?? [] };
      if (js.includes("__uiProbeKey.read()")) return [];
      if (js.includes("__uiProbeKey = {")) return { active: "BODY" };
      if (js.includes("removeEventListener")) return true;
      return null;
    },
  });
  return { ...stub, prompts };
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskAt, maskAt + 4);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode, text: payload.toString("utf8"), rest: buffer.subarray(offset + length) };
}

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
