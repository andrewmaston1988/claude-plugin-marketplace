// The background waiter a seized session runs: loops broker /wait windows until
// a Slack message arrives or the cap, prints it with the reply/re-arm footer and
// exits. The process exiting is what wakes the idle session.
import { WAIT_WINDOW_MS, WAIT_CAP_MS, BASH_TIMEOUT_MS, waitCommand } from "./wait-constants.mjs";

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// Headroom over the broker's own window, so only a genuinely half-open socket hits it.
const ABORT_SLACK_MS = 10_000;

// Must agree with the skill text: the model replies in plain chat (the mirror
// carries it to Slack), never via a tool call.
export function waitFooter(peerId, { configPath } = {}) {
  return `Reply normally — your text is mirrored to Slack. Then re-arm: run ${waitCommand(peerId, { configPath })} with run_in_background and timeout ${BASH_TIMEOUT_MS}.`;
}

const brokerStatus = (e) => Number(/^Broker error \([^)]*\): (\d{3})/.exec(e?.message ?? "")?.[1] ?? 0);

export async function runWaiter({
  peerId,
  client,
  configPath,
  out = (s) => process.stdout.write(s),
  _now = () => Date.now(),
  _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  _signal = (ms) => AbortSignal.timeout(ms),
}) {
  const start = _now();
  let backoff = BACKOFF_START_MS;
  while (_now() - start < WAIT_CAP_MS) {
    let res;
    try {
      res = await client.wait(peerId, WAIT_WINDOW_MS, { signal: _signal(WAIT_WINDOW_MS + ABORT_SLACK_MS) });
    } catch (e) {
      const status = brokerStatus(e);
      if (status === 401) {
        out(`WAIT FAILED: broker rejected the token (401) — check remote.controlToken in the config.\n`);
        return 2;
      }
      // A 4xx is a broker that will never answer this request (e.g. an old broker
      // with no /wait): retrying would hang silently for the whole cap.
      if (status >= 400 && status < 500) {
        out(`WAIT FAILED: ${e.message}\n`);
        return 1;
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
    if (messages.length > 0) {
      for (const m of messages) out(`SLACK: ${m.text}\n`);
      out(waitFooter(peerId, { configPath }) + "\n");
      return 0;
    }
  }
  const hours = ((_now() - start) / 3_600_000).toFixed(1);
  out(`WAIT EXPIRED after ${hours}h — re-arm: ${waitCommand(peerId, { configPath })}\n`);
  return 0;
}
