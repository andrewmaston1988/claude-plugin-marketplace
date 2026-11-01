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
    conversationsInvite: async (p) => { calls.push(["conversationsInvite", p]); return { ok: true }; },
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
    operatorUserId: opts.operatorUserId ?? null,
    log: opts.log ?? (() => {}),
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

test("/claim invites the configured operator to a newly created channel", async (t) => {
  const web = makeWeb();
  const { call } = await startControl(t, { web, operatorUserId: "U-operator" });
  const r = await call("/claim", { peer_id: "peerA" });
  assert.equal(r.body.ok, true);
  assert.ok(web.calls.some(([c, p]) => c === "conversationsInvite" && p.channel === "C-new" && p.users === "U-operator"),
    "must invite the configured operator to the created channel");
});

test("/claim remains successful when the operator invite fails", async (t) => {
  const web = makeWeb();
  web.conversationsInvite = async (p) => { web.calls.push(["conversationsInvite", p]); throw new Error("invite failed"); };
  const logs = [];
  const { call } = await startControl(t, { web, operatorUserId: "U-operator", log: (...args) => logs.push(args) });
  const r = await call("/claim", { peer_id: "peerA" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(web.calls.some(([c]) => c === "conversationsInvite"), "must attempt the invite");
  assert.ok(logs.some(([message]) => /invite/i.test(message)), "must log the invite failure");
});

test("/claim does not invite when no operator is configured, and logs the skip", async (t) => {
  const web = makeWeb();
  const logs = [];
  const { call } = await startControl(t, { web, log: (...args) => logs.push(args) });
  const r = await call("/claim", { peer_id: "peerA" });
  assert.equal(r.body.ok, true);
  assert.ok(!web.calls.some(([c]) => c === "conversationsInvite"), "must skip invite without operatorUserId");
  assert.ok(logs.some(([message]) => /invite skipped/i.test(message)), "a skipped invite must be logged, not silent");
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

function missingScope() {
  const e = new Error("Slack API conversations.join: missing_scope");
  e.slackError = "missing_scope";
  return e;
}

test("/claim of a channel the bot is already in succeeds without the join scope", async (t) => {
  const web = makeWeb();
  web.conversationsJoin = async () => { throw missingScope(); };
  web.conversationsInfo = async (p) => ({ ok: true, channel: { id: p.channel, name: "ops", is_member: true } });
  const { call, claims } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerB", channel: "C-existing" });
  assert.equal(r.body.ok, true, r.body.error);
  assert.equal(r.body.channel_name, "ops");
  assert.equal(claims.get("C-existing").peer_id, "peerB");
});

test("/claim of a channel the bot is not in, without the join scope, says to invite the bot", async (t) => {
  const web = makeWeb();
  web.conversationsJoin = async () => { throw missingScope(); };
  web.conversationsInfo = async (p) => ({ ok: true, channel: { id: p.channel, name: "ops", is_member: false } });
  const { call, claims } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerB", channel: "C-existing" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /invite the bot/i);
  assert.match(r.body.error, /channels:join/);
  assert.equal(claims.get("C-existing"), null);
});

test("/claim without the join scope or channels:read still says to invite the bot", async (t) => {
  const web = makeWeb();
  web.conversationsJoin = async () => { throw missingScope(); };
  web.conversationsInfo = async () => { throw missingScope(); };
  const { call } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerB", channel: "C-existing" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /invite the bot/i);
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

// A rejected claim must not orphan a freshly-created Slack channel: the store
// pre-check runs BEFORE claimChannel touches Slack.
test("/claim by a peer already holding a channel is rejected BEFORE any Slack channel is created", async (t) => {
  const web = makeWeb();
  const claims = createClaimsStore({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl2-")), "claims.json") });
  await claims.claim("peerA", "C1", { channelName: "rc-one" });
  const { call } = await startControl(t, { web, claims });
  const r = await call("/claim", { peer_id: "peerA", name: "second-context" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /already holds/i);
  assert.ok(!web.calls.some(([c]) => c === "conversationsCreate"),
    "a rejected claim must not orphan a created Slack channel");
});

// --- DM-seize (createChannels false) ---
// The fallback selects the OPERATOR's DM by remote.operatorUserId — never the
// first IM in the list, which could be anyone's DM.

test("DM-seize picks the operator's DM when operatorUserId is set", async (t) => {
  const web = {
    conversationsList: async (p) => ({ ok: true, channels: [
      { id: "D-other", user: "U999", name: null },
      { id: "D-op", user: "U123", name: null },
    ] }),
  };
  const { call, claims } = await startControl(t, { web, canCreateChannels: false, operatorUserId: "U123" });
  const r = await call("/claim", { peer_id: "peerA" });
  assert.equal(r.body.ok, true, r.body.error);
  assert.equal(r.body.channel, "D-op", "must match the configured operator's DM, not the first IM");
  assert.equal(r.body.is_dm, true);
  assert.equal(claims.get("D-op").peer_id, "peerA");
});

test("DM-seize refuses when no operatorUserId is configured — never guesses a DM", async (t) => {
  const web = { conversationsList: async () => ({ ok: true, channels: [{ id: "D-anyone", user: "U999" }] }) };
  const { call } = await startControl(t, { web, canCreateChannels: false, operatorUserId: null });
  const r = await call("/claim", { peer_id: "peerA" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /operatorUserId|no channel/i);
});

test("DM-seize refuses when the operator has no DM with the bot yet", async (t) => {
  const web = { conversationsList: async () => ({ ok: true, channels: [{ id: "D-other", user: "U999" }] }) };
  const { call } = await startControl(t, { web, canCreateChannels: false, operatorUserId: "U123" });
  const r = await call("/claim", { peer_id: "peerA" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /no DM/);
});

// ── Seize and release lines, and the history record ─────────────────────────
// Every state change is a Slack attachment carrying the session GUID, so the
// channel history reads back as a timeline of what held it and when.

const GREEN = "#2eb67d";
const YELLOW = "#ecb22e";
const lineOf = (web, kind) => web.calls.find(([c, p]) => c === "chatPostMessage"
  && (p.attachments ?? []).some((a) => a.color === kind));

test("/claim posts the green seized line with the session GUID", async (t) => {
  const web = makeWeb();
  const { call } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerA", session_id: "sess-abc", name: "demo" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const line = lineOf(web, GREEN);
  assert.ok(line, `no green attachment: ${JSON.stringify(web.calls)}`);
  assert.equal(line[1].channel, "C-new");
  assert.equal(line[1].attachments[0].text, "▶️ Claude session `sess-abc` seized this channel");
});

test("/release posts the yellow released line with the session GUID", async (t) => {
  const web = makeWeb();
  const { call } = await startControl(t, { web });
  await call("/claim", { peer_id: "peerA", session_id: "sess-abc" });
  const r = await call("/release", { peer_id: "peerA" });
  assert.equal(r.body.ok, true);
  const line = lineOf(web, YELLOW);
  assert.ok(line, `no yellow attachment: ${JSON.stringify(web.calls)}`);
  assert.equal(line[1].channel, "C-new");
  assert.equal(line[1].attachments[0].text, "⏸️ Claude session `sess-abc` released this channel");
});

test("/release with no live claim posts nothing", async (t) => {
  const web = makeWeb();
  const { call } = await startControl(t, { web });
  const r = await call("/release", { peer_id: "peerX" });
  assert.equal(r.body.ok, true);
  assert.ok(!lineOf(web, YELLOW), "nothing to announce");
});

test("a failed seize line does not fail the claim", async (t) => {
  const web = makeWeb();
  web.chatPostMessage = async (p) => { web.calls.push(["chatPostMessage", p]); throw new Error("channel_not_found"); };
  const logged = [];
  const { call, claims } = await startControl(t, { web, log: (msg, extra) => logged.push([msg, extra]) });
  const r = await call("/claim", { peer_id: "peerA", session_id: "sess-abc" });
  assert.equal(r.body.ok, true, "the claim stands even when the line cannot be posted");
  assert.equal(claims.get("C-new").peer_id, "peerA");
  assert.ok(logged.some(([m]) => /seize line/i.test(m)), JSON.stringify(logged));
});

// The record outlives the claim and supplies the GUID for the red block, so it
// must exist BEFORE the claim does — a claim without one is a channel that
// silently loses its no-spawn rule.
test("/claim writes the history record before the claim", async (t) => {
  const store = createClaimsStore({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-")), "claims.json") });
  const seenAtClaim = [];
  const wrapped = {
    ...store,
    claim(peerId, channel, opts) {
      seenAtClaim.push(store.history(channel));
      return store.claim(peerId, channel, opts);
    },
  };
  const { call } = await startControl(t, { claims: wrapped });
  const r = await call("/claim", { peer_id: "peerA", session_id: "sess-abc", name: "demo" });
  assert.equal(r.body.ok, true);
  assert.deepEqual(seenAtClaim, [{ session_id: "sess-abc", channel_name: "rc-demo" }]);
});

// ── Re-seize reuses the channel ─────────────────────────────────────────────

function memberWeb({ channels = [], lookupError = null } = {}) {
  let creates = 0;
  const web = makeWeb();
  const create = web.conversationsCreate;
  web.conversationsCreate = async (p) => {
    creates++;
    if (creates === 1) {
      const e = new Error(`name_taken: ${p.name}`);
      e.slackError = "name_taken";
      web.calls.push(["conversationsCreate", p]);
      throw e;
    }
    return create(p);
  };
  web.usersConversations = async (p) => {
    web.calls.push(["usersConversations", p]);
    if (lookupError) throw lookupError;
    return { ok: true, channels };
  };
  return web;
}

test("name_taken with a claimable member channel reuses it: no suffix, one create call", async (t) => {
  const web = memberWeb({ channels: [{ id: "C-old", name: "rc-demo", is_member: true }] });
  const { call, claims } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerA", name: "demo" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.channel, "C-old", "the existing channel is reused");
  assert.equal(r.body.channel_name, "rc-demo", "and keeps its name");
  assert.equal(web.calls.filter(([c]) => c === "conversationsCreate").length, 1, "no suffix create");
  assert.equal(claims.get("C-old").peer_id, "peerA");
});

// conversations.create makes public channels, and the manifest grants
// channels:read but no groups:read — asking for private_channel risks a
// missing_scope that silently degrades every re-seize to a -2 suffix.
test("the re-seize lookup asks only for public channels, which the manifest covers", async (t) => {
  const web = memberWeb({ channels: [{ id: "C-old", name: "rc-demo", is_member: true }] });
  const { call } = await startControl(t, { web });
  await call("/claim", { peer_id: "peerA", name: "demo" });

  const lookup = web.calls.find(([c]) => c === "usersConversations");
  assert.equal(lookup[1].types, "public_channel");
});

test("name_taken with a held channel takes the next suffix and never claims the held one", async (t) => {
  const web = memberWeb({ channels: [{ id: "C-held", name: "rc-demo", is_member: true }] });
  const claims = createClaimsStore({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-")), "claims.json") });
  claims.claim("peerOther", "C-held", { channelName: "rc-demo" });
  const { call } = await startControl(t, { web, claims });
  const r = await call("/claim", { peer_id: "peerA", name: "demo" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.channel_name, "rc-demo-2", "the suffix is taken instead");
  assert.equal(claims.get("C-held").peer_id, "peerOther", "the held channel is untouched");
});

test("a lookup failure falls through to the suffix and the seize succeeds", async (t) => {
  const web = memberWeb({ lookupError: Object.assign(new Error("missing_scope"), { slackError: "missing_scope" }) });
  const { call } = await startControl(t, { web });
  const r = await call("/claim", { peer_id: "peerA", name: "demo" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.channel_name, "rc-demo-2");
});

test("a reused channel still gets its topic and operator invite", async (t) => {
  const web = memberWeb({ channels: [{ id: "C-old", name: "rc-demo", is_member: true }] });
  const { call } = await startControl(t, { web, operatorUserId: "U-operator" });
  const r = await call("/claim", { peer_id: "peerA", name: "demo" });
  assert.equal(r.body.ok, true);
  assert.ok(web.calls.some(([c, p]) => c === "conversationsSetTopic" && p.channel === "C-old"), JSON.stringify(web.calls));
  assert.ok(web.calls.some(([c, p]) => c === "conversationsInvite" && p.channel === "C-old" && p.users === "U-operator"));
});
