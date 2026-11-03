// Shared by the stop-hook tests: a fake broker client, a tmp stateDir and a
// fixture transcript, with no network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "../../src/remote/stop-hook.mjs";

export const SID = "sess-1";
export const PEER = "peer-a";

export function fakeClient({ sendDelay = null, fail = false } = {}) {
  const sends = [];
  let listCalls = 0;
  return {
    sends,
    get listCalls() { return listCalls; },
    // Stop never asks the broker whether a waiter is armed: the asyncRewake hook
    // owns the waiter, so any listPeers call is a regression, not a reading.
    async listPeers() {
      listCalls++;
      throw new Error("Stop must never call listPeers");
    },
    async sendMessage(from, to, text, opts = {}) {
      if (fail) throw new Error("fetch failed");
      if (sendDelay) await sendDelay();
      sends.push({ from, to, text, kind: opts.kind ?? "text" });
      return { ok: true };
    },
  };
}

export const textEntry = (uuid, text) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
export const toolEntry = (uuid, name, input) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "tool_use", id: "t" + uuid, name, input }] } });
export const thinkEntry = (uuid) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET THOUGHT" }] } });
export const userEntry = (uuid, text) => ({ type: "user", uuid, message: { role: "user", content: text } });

export function setup(t, { claimed = true, configPath } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stophook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const transcript = path.join(dir, "t.jsonl");
  const cfg = configPath ?? path.join(dir, "custom-config.json");
  fs.writeFileSync(transcript, "");
  if (claimed) {
    fs.mkdirSync(path.join(stateDir, "remote-sessions"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "remote-sessions", `${SID}.json`), JSON.stringify({ peerId: PEER, configPath: cfg, channel: "rc-test" }));
  }
  const append = (...entries) => fs.appendFileSync(transcript, entries.map((e) => JSON.stringify(e) + "\n").join(""));
  const cursorFile = path.join(stateDir, "mirror", `${SID}.json`);
  const cursor = () => (fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, "utf8")).uuid : null);
  return { dir, stateDir, transcript, configPath: cfg, append, cursorFile, cursor };
}

export function hook(env, client, { event = "Stop", active = false, tool, sleeps, sleep, now, loads, createOpts, raw, prompt, lastMessage, toolStart, spawnedAt } = {}) {
  const input = { session_id: SID, transcript_path: env.transcript, hook_event_name: event, stop_hook_active: active };
  if (tool) Object.assign(input, { tool_name: tool.name, tool_input: tool.input, tool_use_id: tool.id });
  if (prompt !== undefined) input.prompt = prompt;
  if (lastMessage !== undefined) input.last_assistant_message = lastMessage;
  return runHook({
    raw: raw ?? JSON.stringify(input),
    toolStart,
    stateDir: env.stateDir,
    _loadConfig: ({ configPath }) => { loads?.push(configPath); return { remote: { brokerPort: 1, controlToken: "tok" } }; },
    _createClient: (opts) => { createOpts?.push(opts); return client; },
    _sleep: sleep ?? (async (ms) => { sleeps?.push(ms); }),
    _now: now,
    _spawnedAt: spawnedAt,
  });
}

// First hook after a seize: starts the cursor at the newest entry, sends nothing.
export async function prime(env) {
  env.append(userEntry("u0", "pre-seize prompt"), textEntry("a0", "PRE-SEIZE TEXT"));
  await hook(env, fakeClient(), { event: "PostToolUse", tool: { name: "mcp__slack__slack_seize", input: {} } });
}

export const textSends = (c) => c.sends.filter((s) => s.kind === "text");
