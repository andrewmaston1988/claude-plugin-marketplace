// asyncRewake Stop hook for a session holding a Slack claim: runs the waiter in
// the background, owned by the harness rather than the model. Exit 2 wakes the
// idle session with the waiter's stderr as a system reminder; the turn that wake
// runs ends in another Stop, which starts the next waiter. The broker's /wait
// supersede keeps it single-flight when a Stop fires with a waiter still open.
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPaths } from "../paths.mjs";
import { loadConfig } from "../config.mjs";
import { createBrokerClient } from "./broker-client.mjs";
import { readSessionFile } from "./stop-hook.mjs";
import { runWaiter, prepareBroker, writeTo } from "./waiter.mjs";
import { FAILURE_COOLDOWN_MS } from "./wait-constants.mjs";

// asyncRewake hands stderr to the model; stdout goes nowhere it can read.
const stderrOut = (s) => writeTo(process.stderr, s);

// A deterministic failure (a rotated token, a bad config) would otherwise wake
// the session on every Stop: the wake's own turn ends in another Stop, which
// fails the same way, forever. The marker records the last such wake.
const failureMarkerPath = (stateDir, sessionId) => join(stateDir, "remote-sessions", `${sessionId}.failed`);

// Atomic so a concurrent Stop never reads a half-written marker as absent.
function writeFailureMarker(stateDir, sessionId) {
  const destination = failureMarkerPath(stateDir, sessionId);
  const tmp = `${destination}.tmp`;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(tmp, "");
    renameSync(tmp, destination);
  } catch {
    // An unwritable marker must not cost the wake itself.
  }
}

function recentlyFailed(stateDir, sessionId, now) {
  try {
    return now - statSync(failureMarkerPath(stateDir, sessionId)).mtimeMs < FAILURE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

export async function runRewakeHook({
  raw,
  stateDir = getPaths().stateDir,
  _loadConfig = loadConfig,
  _createClient = createBrokerClient,
  _runWaiter = runWaiter,
  _signal = AbortSignal.timeout,
  _now = () => Date.now(),
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

  // A recent failure already woke a turn; another Stop inside the cooldown would
  // fail identically. Stay silent and try again once it lapses.
  if (recentlyFailed(stateDir, input.session_id, _now())) return 0;

  // The waiter's own wake text is the signal: a WAIT FAILED line means the next
  // Stop would repeat the failure, so this run leaves the marker behind.
  let failed = false;
  const out = (s) => {
    if (String(s).startsWith("WAIT FAILED")) failed = true;
    return stderrOut(s);
  };

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
    await out(`WAIT FAILED: ${e?.message ?? e}\n`).catch(() => {});
    writeFailureMarker(stateDir, input.session_id);
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

  const code = await _runWaiter({ peerId: session.peerId, client, stillNeeded, out });
  if (failed) writeFailureMarker(stateDir, input.session_id);
  return code;
}
