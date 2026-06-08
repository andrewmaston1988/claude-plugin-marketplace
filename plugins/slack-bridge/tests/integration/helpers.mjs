import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startMockSlack } from "./mock-server.mjs";
import { createWebClient } from "../../src/web-api/index.mjs";
import { createSocketModeClient } from "../../src/socket-mode/index.mjs";
import { createSessionStore } from "../../src/session-store/index.mjs";
import { createQueue } from "../../src/core/queue.mjs";
import { startBridge } from "../../src/index.mjs";

const FIXTURES_BIN = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/bin");

const noop = { info() {}, warn() {}, error() {}, child() { return noop; } };

/**
 * Spin up a mock Slack server + a bridge pointing at it.
 * Injects FIXTURES_BIN/claude.cmd as the claude executable.
 *
 * @param {{ scenario?: object, config?: object, mockResponse?: string }} opts
 * @returns {Promise<{ mock, bridge, stop }>}
 */
export async function startTestBridge({ scenario = {}, config: extraConfig = {}, mockResponse } = {}) {
  const mock = await startMockSlack({ scenario });

  // Patch PATH so "claude" resolves to our mock
  const origPath = process.env.PATH;
  process.env.PATH = FIXTURES_BIN + (process.platform === "win32" ? ";" : ":") + origPath;
  if (mockResponse) process.env.CLAUDE_MOCK_RESPONSE = mockResponse;

  const config = {
    tokens: { bot: "xoxb-test", app: "xapp-test" },
    claude: { cwd: process.cwd(), timeout: 10_000 },
    slack: { historyLimit: 0 },
    ...extraConfig,
  };

  // Override fetch to point at mock server
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const patchedUrl = url.replace("https://slack.com/api", mock.url + "/api");
    return origFetch(patchedUrl, opts);
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "slack-bridge-test-"));
  const web    = createWebClient({ token: config.tokens.bot, log: noop });
  const socket = createSocketModeClient({ appToken: config.tokens.app, log: noop });
  const store  = createSessionStore({ path: join(tmpDir, "sessions.json"), log: noop });
  const queue  = createQueue({ log: noop });

  startBridge({ config, log: noop, web, socket, store, queue });

  // Wait for WS connection
  await new Promise(r => mock.events.once("ws-connected", r));

  return {
    mock,
    stop: async () => {
      // Stop the socket-mode client first so it doesn't try to reconnect
      socket.stop();
      globalThis.fetch = origFetch;
      process.env.PATH = origPath;
      delete process.env.CLAUDE_MOCK_RESPONSE;
      await mock.stop();
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    },
  };
}

/** Wait up to timeoutMs for predicate to return true, checking every 50ms. */
export async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}
