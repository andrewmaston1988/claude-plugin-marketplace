// Pure keepalive cadence math. No I/O.

export const REFERENCE_TTL_SECS = 300;

// ScheduleWakeup hard-clamps delaySeconds to this range; delay fields must fit.
export const WAKEUP_MIN_SECS = 60;
export const WAKEUP_MAX_SECS = 3600;

// Ratios of TTL, calibrated on the original 300s constants (255/240/180/270/240/12x).
const TARGET_RATIO     = 0.85; // aim ~15% under TTL
const FIRST_RATIO      = 0.80; // first tick, no history
const MIN_RATIO        = 0.60;
const MAX_RATIO        = 0.90;
const CHAIN_DEAD_RATIO = 0.80;
const IDLE_STOP_MULT   = 12;   // 1h at 5m TTL, 12h at 1h TTL

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Derive all cadence values from the cache TTL. Delay fields are clamped to
// the ScheduleWakeup range; chainDead/idleStop are elapsed-time thresholds,
// not wakeup delays, so they stay unclamped.
export function cadenceFor(ttlSecs, { idleStopSecs } = {}) {
  const ttl = (Number.isFinite(ttlSecs) && ttlSecs > 0) ? ttlSecs : REFERENCE_TTL_SECS;
  const delay = (ratio) => clamp(Math.round(ttl * ratio), WAKEUP_MIN_SECS, WAKEUP_MAX_SECS);
  return {
    ttlSecs: ttl,
    targetSecs: delay(TARGET_RATIO),
    firstDelaySecs: delay(FIRST_RATIO),
    minDelaySecs: delay(MIN_RATIO),
    maxDelaySecs: delay(MAX_RATIO),
    chainDeadSecs: Math.round(ttl * CHAIN_DEAD_RATIO),
    idleStopSecs: (Number.isFinite(idleStopSecs) && idleStopSecs > 0) ? idleStopSecs : ttl * IDLE_STOP_MULT,
  };
}

const REFERENCE = cadenceFor(REFERENCE_TTL_SECS);
export const TARGET_CADENCE_SECS       = REFERENCE.targetSecs;
export const FIRST_DELAY_SECS          = REFERENCE.firstDelaySecs;
export const MIN_DELAY_SECS            = REFERENCE.minDelaySecs;
export const MAX_DELAY_SECS            = REFERENCE.maxDelaySecs;
export const TTL_SECS                  = REFERENCE.ttlSecs;
export const KEEPALIVE_CHAIN_DEAD_SECS = REFERENCE.chainDeadSecs;
export const KEEPALIVE_IDLE_STOP_SECS  = REFERENCE.idleStopSecs;

// Which cache bucket did this turn write to? 3600 | 300 | null (no signal —
// e.g. a pure cache-hit turn creates nothing in either bucket). Any 5m write
// means some content expires on the short clock, so 5m wins mixed turns.
export function ttlFromUsage(usage) {
  const cc = usage && usage.cache_creation;
  if (!cc) return null;
  const h1 = cc.ephemeral_1h_input_tokens || 0;
  const m5 = cc.ephemeral_5m_input_tokens || 0;
  if (m5 > 0) return 300;
  return h1 > 0 ? 3600 : null;
}

// Precedence: forced settings override > newest usage row with a bucket signal
// > last known (persisted in session state) > conservative 300s default.
// Under-estimating the TTL just ticks more often; over-estimating kills the cache.
export function resolveTtl(forcedTtlSecs, usages, lastKnownTtlSecs) {
  if (Number.isFinite(forcedTtlSecs) && forcedTtlSecs > 0) return forcedTtlSecs;
  for (let i = usages.length - 1; i >= 0; i--) {
    const t = ttlFromUsage(usages[i]);
    if (t) return t;
  }
  if (Number.isFinite(lastKnownTtlSecs) && lastKnownTtlSecs > 0) return lastKnownTtlSecs;
  return REFERENCE_TTL_SECS;
}

// observedGap / lastInjectedDelay in seconds. Falsy -> no history -> first delay.
export function nextDelay(observedGap, lastInjectedDelay, cad = REFERENCE) {
  if (!observedGap || !lastInjectedDelay) return cad.firstDelaySecs;
  const overshoot = Math.max(0, observedGap - lastInjectedDelay); // jitter + turn latency
  return clamp(cad.targetSecs - overshoot, cad.minDelaySecs, cad.maxDelaySecs);
}

// prevUserIdleSecs: seconds since last *user* prompt (Infinity if never).
// prevSinceAnySecs: seconds since last activity incl. ticks (Infinity if never).
// Returns 'stop' | 'inject' | 'none'.
export function keepaliveAction(prevUserIdleSecs, prevSinceAnySecs, isTick, cad = REFERENCE) {
  const userIdleStop = Number.isFinite(prevUserIdleSecs) && prevUserIdleSecs >= cad.idleStopSecs;
  if (userIdleStop) return 'stop';
  const chainDead = prevSinceAnySecs >= cad.chainDeadSecs;
  if (isTick || chainDead) return 'inject';
  return 'none';
}
