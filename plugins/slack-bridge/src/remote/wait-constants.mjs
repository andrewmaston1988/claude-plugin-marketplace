// Single home for the waiter's timing. The waiter loop and the hooks.json
// timeout test both read from here, so the numbers can never drift apart.

// One long-poll window. Short on purpose: an idle HTTP socket held for hours is
// what a reconnect or a broker restart kills, so every failure is a retry at a
// window boundary rather than a lost waiter.
export const WAIT_WINDOW_MS = 55_000;

// Strictly under HOOK_TIMEOUT_MS: the waiter writes its expiry line and exits 2
// on its own before the harness kills the hook, so expiry is a wake rather than
// a silent death.
export const WAIT_CAP_MS = 6_900_000;

// hooks.json's rewake-hook `timeout` (7200 s), pinned by a test. The harness
// kills a hook at its timeout silently — no wake, the message stranded — so the
// cap must clear it by more than one worst loop iteration: a window plus its
// abort slack (65 s), ensureBroker's retries (~6 s) and a full backoff (30 s).
export const HOOK_TIMEOUT_MS = 7_200_000;

// After a WAIT FAILED wake the hook stays silent this long, so a deterministic
// failure (a rotated token, a bad config) cannot burn a turn on every Stop.
export const FAILURE_COOLDOWN_MS = 600_000;
