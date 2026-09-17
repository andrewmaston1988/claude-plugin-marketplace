// Control endpoint: the localhost HTTP surface the live session's MCP server
// calls to seize/release a Slack channel and post outbound messages. Token-guarded.
// Uses a mock `web` Slack client — no real Slack.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createControlServer } from "../../src/remote/control.mjs";
import { createClaimsStore } from "../../src/remote/claims.mjs";

function makeWeb() {
  const calls = [];
  return {
    calls,
    conversationsCreate: async (p) => { calls.push(["conversationsCreate", p]); return { ok: true, channel: { id: "C-new", name: p.name } }; },
    conversationsJoin: async (p) => { calls.push(["conversationsJoin", p]); return { ok: true, channel: { id: p.channel, name: "joined" } }; },
    conversationsSetTopic: async (p) => { calls.push(["conversationsSetTopic", p]); return { ok: true }; },
    chatPostMessage: async (p) => { calls.push(["chatPostMessage", p]); return { ok: true, ts: "ts1" }; },
  };
}

async function startControl(t, opts = {}) {
  const claims = opts.claims ?? createClaimsStore({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-")), "claims.json") });
  const server = createControlServer({
    web: opts.web ?? makeWeb(),
    claims,
    token: opts.token ?? "secret",
    canCreateChannels: opts.canCreateChannels ?? true,
    log: () => {},
  });
  t.after(() => server.close());
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, body, { token = "secret" } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + p, {
      method: "POST", headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const get = async (p, { token = "secret" } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + p, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, port, claims, call, get };
}

test("/claim with no channel + no name creates a #rc-<peer-id-short> channel, sets topic, records claim", async (t) => {
  const web = makeWeb();
  const { call, claims } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerA" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.channel, "C-new");
  assert.equal(r.body.channel_name, "rc-peer");
  const createCall = web.calls.find(([c]) => c === "conversationsCreate");
  assert.ok(createCall, "must call conversations.create");
  assert.equal(createCall[1].name, "rc-peer");
  const topicCall = web.calls.find(([c]) => c === "conversationsSetTopic");
  assert.ok(topicCall, "must set the topic");
  assert.equal(topicCall[1].channel, "C-new");
  // claim recorded against the created channel id
  assert.equal(claims.get("C-new").peer_id, "peerA");
});

test("/claim with a name creates a #rc-<name-slug> channel describing the context", async (t) => {
  const web = makeWeb();
  const { call, claims } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerA", name: "Slack Remote Setup!" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.channel_name, "rc-slack-remote-setup");
  const createCall = web.calls.find(([c]) => c === "conversationsCreate");
  assert.ok(createCall, "must call conversations.create");
  assert.equal(createCall[1].name, "rc-slack-remote-setup");
  assert.equal(claims.get("C-new").peer_id, "peerA");
});

test("/claim with an empty/whitespace name falls back to the peer-id fragment", async (t) => {
  const web = makeWeb();
  const { call } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerA", name: "   " });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.channel_name, "rc-peer");
});

test("/claim with a channel joins the existing channel instead of creating", async (t) => {
  const web = makeWeb();
  const { call, claims } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerB", channel: "C-existing" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.channel, "C-existing");
  assert.ok(!web.calls.some(([c]) => c === "conversationsCreate"), "must NOT create a new channel");
  assert.ok(web.calls.some(([c]) => c === "conversationsJoin"), "must join the existing channel");
  assert.equal(claims.get("C-existing").peer_id, "peerB");
});

test("/release clears the claim", async (t) => {
  const claims = createClaimsStore({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rel-")), "claims.json") });
  await claims.claim("peerA", "C1");
  const { call } = await startControl(t, { claims });
  const r = await call("/release", { peer_id: "peerA" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(claims.get("C1"), null);
});

test("GET /health returns ok", async (t) => {
  const { get } = await startControl(t);
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
});

test("requests without the bearer token are rejected with 401", async (t) => {
  const { call, get } = await startControl(t);
  const r = await call("/claim", { peer_id: "peerA" }, { token: null });
  assert.equal(r.status, 401);
  const healthNoToken = await get("/health", { token: null });
  assert.equal(healthNoToken.status, 401);
});

test("requests with the wrong bearer token are rejected with 401", async (t) => {
  const { call } = await startControl(t);
  const r = await call("/claim", { peer_id: "peerA" }, { token: "wrong" });
  assert.equal(r.status, 401);
});