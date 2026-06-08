import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWebClient } from "../src/web-api/index.mjs";

function makeLog() {
  const warns = [];
  return {
    info: () => {},
    warn: (...a) => warns.push(a),
    error: () => {},
    warns,
  };
}

function stubServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function makeClient(port, log) {
  // Patch SLACK_API base url by creating client pointed at localhost
  const client = createWebClient({ token: "xoxb-test", log: log ?? makeLog() });
  // Override fetch to point at our stub — we do this by monkey-patching inside the test scope
  return { client, baseUrl: `http://127.0.0.1:${port}` };
}

// Helper: creates client with fetch overridden to hit local stub server
function clientForServer(port, log) {
  const l = log ?? makeLog();
  const origFetch = globalThis.fetch;
  const patchedFetch = (url, opts) => origFetch(url.replace("https://slack.com", `http://127.0.0.1:${port}`), opts);
  globalThis.fetch = patchedFetch;
  const client = createWebClient({ token: "xoxb-test", log: l });
  return { client, log: l, restore: () => { globalThis.fetch = origFetch; } };
}

test("web-api — authTest sends Bearer token and returns parsed JSON", async () => {
  let receivedAuth;
  const { server, port, close } = await stubServer((req, res) => {
    receivedAuth = req.headers["authorization"];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, user_id: "U123" }));
  });
  const { client, restore } = clientForServer(port);
  try {
    const result = await client.authTest();
    assert.equal(result.user_id, "U123");
    assert.equal(receivedAuth, "Bearer xoxb-test");
  } finally { restore(); await close(); }
});

test("web-api — error envelope throws with slackError property", async () => {
  const { server, port, close } = await stubServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "channel_not_found" }));
  });
  const { client, restore } = clientForServer(port);
  try {
    await assert.rejects(
      () => client.chatPostMessage({ channel: "C1", text: "hi" }),
      (err) => {
        assert.equal(err.slackError, "channel_not_found");
        return true;
      }
    );
  } finally { restore(); await close(); }
});

test("web-api — chatUpdate strips id field", async () => {
  let body;
  const { server, port, close } = await stubServer((req, res) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => {
      body = JSON.parse(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: "123" }));
    });
  });
  const { client, restore } = clientForServer(port);
  try {
    await client.chatUpdate({ channel: "C1", ts: "123", id: 1, text: "hi" });
    assert.ok(!("id" in body), "id field should be stripped from chatUpdate body");
    assert.equal(body.channel, "C1");
  } finally { restore(); await close(); }
});

test("web-api — 429 with Retry-After retries once and succeeds", async () => {
  let calls = 0;
  const { server, port, close } = await stubServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { "Retry-After": "0" });
      res.end("");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: "456" }));
    }
  });
  const log = makeLog();
  const { client, restore } = clientForServer(port, log);
  try {
    const result = await client.chatPostMessage({ channel: "C1", text: "hi" });
    assert.equal(result.ts, "456");
    assert.equal(calls, 2, "should have made exactly 2 requests");
    assert.equal(log.warns.length, 1, "should have warned once");
  } finally { restore(); await close(); }
});

test("web-api — two consecutive 429s throws ratelimited error", async () => {
  const { server, port, close } = await stubServer((req, res) => {
    res.writeHead(429, { "Retry-After": "0" });
    res.end("");
  });
  const log = makeLog();
  const { client, restore } = clientForServer(port, log);
  try {
    await assert.rejects(
      () => client.chatPostMessage({ channel: "C1", text: "hi" }),
      (err) => {
        assert.equal(err.slackError, "ratelimited");
        return true;
      }
    );
    assert.equal(log.warns.length, 2);
  } finally { restore(); await close(); }
});
