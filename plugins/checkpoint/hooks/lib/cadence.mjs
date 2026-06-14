// Pure keepalive cadence math. No I/O.

export const TARGET_CADENCE_SECS    = 255;  // aim ~45s under the 300s TTL
export const FIRST_DELAY_SECS       = 240;  // first tick, no history
export const MIN_DELAY_SECS         = 180;
export const MAX_DELAY_SECS         = 270;
export const TTL_SECS               = 300;  // reference cache TTL
export const KEEPALIVE_CHAIN_DEAD_SECS = 240;
export const KEEPALIVE_IDLE_STOP_SECS  = 3600;

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// observedGap / lastInjectedDelay in seconds. Falsy -> no history -> first delay.
export function nextDelay(observedGap, lastInjectedDelay) {
  if (!observedGap || !lastInjectedDelay) return FIRST_DELAY_SECS;
  const overshoot = Math.max(0, observedGap - lastInjectedDelay); // jitter + turn latency
  return clamp(TARGET_CADENCE_SECS - overshoot, MIN_DELAY_SECS, MAX_DELAY_SECS);
}

// prevUserIdleSecs: seconds since last *user* prompt (Infinity if never).
// prevSinceAnySecs: seconds since last activity incl. ticks (Infinity if never).
// Returns 'stop' | 'inject' | 'none'.
export function keepaliveAction(prevUserIdleSecs, prevSinceAnySecs, isTick) {
  const userIdleStop = Number.isFinite(prevUserIdleSecs) && prevUserIdleSecs >= KEEPALIVE_IDLE_STOP_SECS;
  if (userIdleStop) return 'stop';
  const chainDead = prevSinceAnySecs >= KEEPALIVE_CHAIN_DEAD_SECS;
  if (isTick || chainDead) return 'inject';
  return 'none';
}
