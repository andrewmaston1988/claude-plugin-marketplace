// asyncRewake Stop hook for a session holding a Slack claim: runs the waiter in
// the background, owned by the harness rather than the model. Exit 2 wakes the
// idle session with the waiter's stderr as a system reminder; the turn that wake
// runs ends in another Stop, which starts the next waiter. The broker's /wait
// supersede keeps it single-flight when a Stop fires with a waiter still open.
import { getPaths } from "../paths.mjs";
import { loadConfig } from "../config.mjs";
import { createBrokerClient } from "./broker-client.mjs";
import { readSessionFile } from "./stop-hook.mjs";
import { runWaiter, prepareBroker, writeTo } from "./waiter.mjs";

// asyncRewake hands stderr to the model; stdout goes nowhere it can read.
const stderrOut = (s) => writeTo(process.stderr, s);

export async function runRewakeHook({
  raw,
  stateDir = getPaths().stateDir,
  _loadConfig = loadConfig,
  _createClient = createBrokerClient,
  _runWaiter = runWaiter,
  _signal = AbortSignal.timeout,
}) {
  let input, session;
  // Absent file = no claim held: exit before any config load or broker call,
  // which keeps every turn's Stop cheap on unclaimed sessions.
  try {
    input = JSON.parse(raw);
    session = readSessionFile(stateDir, input?.session_id);
  } catch {
    return 0;
  }
  if (!session) return 0;

  // A load failure after the claim is found must wake the session: exiting
  // silently would leave the operator's claim deaf until their next turn.
  let client;
  try {
    const config = _loadConfig({ configPath: session.configPath });
    client = _createClient({
      port: config.remote?.brokerPort ?? 7898,
      token: config.remote?.controlToken ?? null,
      configPath: session.configPath,
    });
    await prepareBroker({ client });
  } catch (e) {
    await stderrOut(`WAIT FAILED: ${e?.message ?? e}\n`).catch(() => {});
    return 2;
  }

  // Nothing on the broker side ends a waiter whose claim is gone (/wait never
  // rejects a reaped peer), so it checks for itself. The file alone is not
  // enough: a re-seize rewrites it to a new peer. No row means reaped, as the
  // claims reaper reads it; a failed lookup is a blip, never a verdict.
  const stillNeeded = async () => {
    const current = readSessionFile(stateDir, input.session_id);
    if (current?.peerId !== session.peerId) return false;
    let peers;
    try {
      peers = await client.listPeers({}, { signal: _signal(5000) });
    } catch {
      return true;
    }
    return peers.some((p) => p.id === session.peerId);
  };

  return _runWaiter({ peerId: session.peerId, client, stillNeeded, out: stderrOut });
}
