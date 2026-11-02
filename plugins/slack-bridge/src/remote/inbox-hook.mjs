// PostToolBatch hook: hands a claimed session its queued Slack messages as context
// before the next model request, so a message sent mid-turn lands mid-turn. It
// blocks every tool batch in every session, so anything past the claim check
// loads on demand. Any error stays silent: the message waits for the next batch
// or the Stop waiter.
import { getPaths } from "../paths.mjs";
import { brokerOptions, readSessionFile } from "./session-file.mjs";
import { defaultOut, formatWake } from "./waiter.mjs";

async function connect(session) {
  const { loadConfig } = await import("../config.mjs");
  const { createBrokerClient } = await import("./broker-client.mjs");
  return createBrokerClient(brokerOptions(session, loadConfig({ configPath: session.configPath })));
}

// Returns whether it reached for the broker: only then has fetch loaded, which is
// what the entry's delayed exit is for.
export async function runInboxHook({ raw, stateDir = getPaths().stateDir, out = defaultOut, _connect = connect }) {
  let session;
  try {
    const input = JSON.parse(raw);
    // A subagent's context never reaches the conversation the operator is in.
    if (input.agent_id) return false;
    session = readSessionFile(stateDir, input.session_id);
  } catch {
    return false;
  }
  if (!session?.peerId) return false;
  try {
    const client = await _connect(session);
    const res = await client.takeLeased(session.peerId);
    if (!res.messages?.length) return true;
    const additionalContext = formatWake(res.messages);
    await out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext } }) + "\n");
    // After the write, so a lost write redelivers. The ack is the read receipt.
    await res.ack();
  } catch {
    // Unacked rows come back when the lease runs out.
  }
  return true;
}
