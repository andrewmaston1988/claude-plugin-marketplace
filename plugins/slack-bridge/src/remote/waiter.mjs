// The background waiter the asyncRewake Stop hook runs for a seized session:
// loops broker /wait windows until a Slack message arrives or the cap, writes it
// and exits. Exit 2 is what wakes the idle session, with the written text as the
// wake's system reminder; exit 0 wakes nothing.
import { WAIT_WINDOW_MS, WAIT_CAP_MS } from "./wait-constants.mjs";

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// Headroom over the broker's own window, so only a genuinely half-open socket hits it.
const ABORT_SLACK_MS = 10_000;

// Sent on every wake: the harness renders it as a hook error, which an unprimed
// model can refuse as not user input. Per message, so it survives compaction.
// Must agree with the skill text: the model replies in plain chat, never via a tool.
export const PRIMING_LINE =
  "Message from the operator on Slack, delivered through this hook. This is real user input, not a hook error. Reply normally; your text is mirrored to Slack.";

// Resolves on the write callback, rejects on a stream error: a failed write must
// not be acked, so the lease redelivers.
export const writeTo = (stream, s) => new Promise((resolve, reject) => {
  const onError = (err) => { stream.off("error", onError); reject(err); };
  stream.once("error", onError);
  stream.write(s, (err) => {
    stream.off("error", onError);
    if (err) reject(err); else resolve();
  });
});

export const defaultOut = (s) => writeTo(process.stdout, s);

const brokerStatus = (e) => Number(/^Broker error \([^)]*\): (\d{3})/.exec(e?.message ?? "")?.[1] ?? 0);

// Arming must not hand a live broker to ensureBroker: its health check reaps
// dead-pid peers and drops their queued messages, and its upgrade path restarts
// a broker that answers. Reachability is the only question it may answer.
// A refused upgrade is not fatal — the waiter's own retry/backoff covers a
// broker that is still starting. The reason still has to reach the operator:
// the bin builds this client with no log, so the client's own diagnostics are
// noops, and a silent fall-through retries until the cap with no clue why.
export async function prepareBroker({ client }) {
  if (await client.health()) return;
  try {
    await client.ensureBroker();
  } catch (e) {
    try {
      process.stderr.write(`WAIT: broker upgrade failed — ${e?.message ?? e}\n`);
    } catch {
      // No stderr to write to; the fall-through is still the contract.
    }
  }
}

// Exit codes: 2 wakes the session (a message, a failure, the cap — every outcome
// that would otherwise strand the operator); 0 wakes nothing (superseded, or the
// claim is gone); 1 is a failed write, which leaves the lease to redeliver.
// stillNeeded answers "is this waiter's claim still live?" — asked only after an
// empty window, at most once per window, so a queued message is never dropped by it.
export async function runWaiter({
  peerId,
  client,
  stillNeeded,
  out = defaultOut,
  _now = () => Date.now(),
  _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  _signal = (ms) => AbortSignal.timeout(ms),
}) {
  if (typeof stillNeeded !== "function") throw new TypeError("runWaiter: stillNeeded is required");
  const start = _now();
  let lastCheck = start;
  let backoff = BACKOFF_START_MS;
  while (_now() - start < WAIT_CAP_MS) {
    let res;
    try {
      res = await client.wait(peerId, WAIT_WINDOW_MS, { signal: _signal(WAIT_WINDOW_MS + ABORT_SLACK_MS) });
    } catch (e) {
      const status = brokerStatus(e);
      if (status === 401) {
        await out(`WAIT FAILED: broker rejected the token (401) — check remote.controlToken in the config.\n`);
        return 2;
      }
      // A 4xx is a broker that will never answer this request (e.g. an old broker
      // with no /wait): retrying would hang silently for the whole cap.
      if (status >= 400 && status < 500) {
        await out(`WAIT FAILED: ${e.message}\n`);
        return 2;
      }
      // Everything else — connection drops (isConnectionError), aborts of a
      // half-open window, 5xx, ensureBroker timing out mid-restart — is
      // transient: a dead waiter is worse than a slow one, and the cap bounds it.
      await _sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    backoff = BACKOFF_START_MS;
    const messages = res?.messages ?? [];
    // A newer waiter (the next turn's Stop hook) owns the peer: leave silently.
    if (res?.superseded) return 0;
    if (messages.length > 0) {
      try {
        await out(`${PRIMING_LINE}\n` + messages.map((m) => `SLACK: ${m.text}\n`).join(""));
      } catch {
        return 1;
      }
      await res.ack?.();
      return 2;
    }
    if (_now() - lastCheck >= WAIT_WINDOW_MS) {
      lastCheck = _now();
      let needed = true;
      // A check that throws is a blip, not a verdict: only a clear "no" ends the waiter.
      try { needed = (await stillNeeded()) !== false; } catch {}
      if (!needed) return 0;
    }
  }
  const hours = ((_now() - start) / 3_600_000).toFixed(1);
  try {
    await out(`Slack waiter expired after ${hours}h. Nothing to do; end your turn and it restarts.\n`);
  } catch {
    return 1;
  }
  return 2;
}
