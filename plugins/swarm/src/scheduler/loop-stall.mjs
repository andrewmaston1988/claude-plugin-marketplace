// Event-loop stalls, measured engine-wide. A launch runs `git worktree add` through
// spawnSync, which blocks the loop and starves every callback a running leaf armed —
// including the leaf's own exit. Charging a leaf for that time is what turned machine
// load into a leaf timeout; the scheduler charges live loop time instead.

const TICK_MS = 250;
// Sub-tick noise is ordinary scheduling jitter, not a stall. The same floor keeps a
// timer's re-arm worth doing: a few milliseconds of credit buys nothing.
const MIN_STALL_MS = 100;

let totalMs = 0;
let lastTickMs = 0;
let started = false;

function tick() {
  const now = Date.now();
  const gap = now - lastTickMs - TICK_MS;
  if (gap > MIN_STALL_MS) totalMs += gap;
  lastTickMs = now;
}

// Started on first use, and unref'd: the monitor must never keep a process alive.
function start() {
  if (started) return;
  started = true;
  lastTickMs = Date.now();
  const interval = setInterval(tick, TICK_MS);
  if (interval.unref) interval.unref();
}

// Every stall so far, plus the one still in progress at the moment of the call: the
// loop is blocked while a caller measures it, so its tick has not fired yet.
export function loopStallMs() {
  start();
  const gap = Date.now() - lastTickMs - TICK_MS;
  return totalMs + (gap > MIN_STALL_MS ? gap : 0);
}

// The re-arm decision for a leaf whose budget just elapsed. `charged` is the stall
// already credited to this leaf; `credit` is what it has been given in total, capped
// at one budget because the stall total is engine-wide and an uncapped credit would
// extend a hung leaf for as long as any other leaf keeps stalling. Returns the next
// bookkeeping: extra 0 means no re-arm, so the leaf times out.
export function nextStallCredit({ stallMs, chargedMs, creditMs, timeoutMs }) {
  const extra = Math.min(stallMs - chargedMs, timeoutMs - creditMs);
  if (extra <= MIN_STALL_MS) return { extra: 0, chargedMs, creditMs };
  return { extra, chargedMs: chargedMs + extra, creditMs: creditMs + extra };
}
