# Reading a live roster — mid-run reference

Read this when a run is in flight and you are judging whether a leaf is healthy,
or when a completed leaf produced nothing. It is situational: none of it is needed
to author a manifest.

## Reading the roster — a leaf is an AGENT, not an API call

**A `:cloud` leaf is a full autonomous agent**, running its own multi-turn loop: it greps, reads, reasons, greps again, dozens or hundreds of turns, until it has an answer. It is not one request/response. Judge it as you would a colleague working a problem for fifteen minutes — not as a query that should have returned by now.

**Their token counts are enormous, and that is arithmetic, not pathology.** These providers report no prompt-cache buckets (`cache_creation_input_tokens` / `cache_read_input_tokens` come back absent). So every turn re-sends the agent's entire growing transcript as *fresh input*, and `tokenTotal` counts it (`input + output + cacheCreation` — `cacheRead` is deliberately excluded). A Claude leaf doing identical work parks that same re-sent prefix in `cacheRead`, which the roster does **not** count. The number is real; the magnitude is an accounting artefact of where the bucket lands.

Read the two columns for what they are: **`output` is the work. `input` is the transcript re-sent, once per turn.**

| What you see | What it means |
|---|---|
| A `:cloud` leaf at 1M–20M+ tokens | **Normal.** Input/output ratios of 100–180× are the ordinary signature of a working agent. Observed in real runs: a 21.3M-token leaf produced 116k output — it re-read its own context ~180 times. |
| Its `costUsd` (`$108`, `$53`) | **Not a number.** The CLI applies its own price table to token counts; these providers bill on subscription and GPU time with no token mapping. Never quote it, never act on it. |
| The activity cell (`Grep("handler")`) | The **most recent** tool call — a heartbeat, proof of life. NOT a call the leaf has been stuck on. A leaf showing a tool call is a leaf that is working. |
| One leaf far slower than its siblings | **Normal.** Leaves have different amounts to do. 840s next to 184s is scope, not sickness. |

**What IS a real signal** — watch these instead, because they are the ones the engine actually raises:

- **`⚠ quiet <N>s`** in the activity cell — the leaf has emitted no event for longer than the quiet threshold. *This* is the stall indicator. A leaf with a live activity cell is not stalled, no matter its token count.
- States: **`failed`**, **`rate-limited`**, **`quota`**, **`retrying`**, **`blocked`** — all tagged explicitly on the row.
- The closing block's truncation warnings.

**There is no per-leaf kill.** Do not propose one. The run is the unit; killing it kills every leaf's work, and resume re-runs the incomplete ones anyway.

**Pathological leaves are real — you just don't detect them with the token column.** A `nemotron-3-super` verifier once burned 27.3M tokens across three leaves, timed out on two, and fabricated all 18 refutations on the one that finished. That is a genuine runaway. But note *how it surfaced*: two leaves hit `timeoutMs`, and the engine's mechanical citation check caught the fabrications for zero tokens. The bound did its job. The token count was a *symptom* that arrived too late to act on and would have been indistinguishable, mid-run, from a healthy leaf doing a lot of work. The defences against a runaway are **pre-dispatch** — the right model tier, a closed scope over a named file set, a `returns` citation schema, a sane `timeoutMs` — not a mid-run judgement call about a big number. If a leaf is genuinely sick, the timeout or the citation check will say so. Your panic will not.

### Red flags — you are about to interfere with a healthy run

Every phrase below came from a session that read a *working* roster and moved to kill it:

- "21.3M tokens is **runaway**" · "that's not still working, that's a **runaway**"
- "**pure burn** with no sign it's converging" · "a 7x token blowup relative to its sibling leaves"
- "it's been **stuck on a single `Grep`** for 14 minutes" (it hasn't — that's the latest call)
- "the leaf is **drowning in matched context** / re-consuming its own output"
- "I'd **kill `scan-api` now**" · "I'll give it 2–3 more minutes, then kill it"

**All of these mean: you are reading token magnitude as health. It isn't. Check the activity cell for `⚠ quiet`, check the state tags, and otherwise let it run.** A leaf that is grepping is a leaf that is working. Report progress to the user; do not intervene.

### A leaf ended and produced no commit — recover, never kill

The red flags above are about a *healthy* run. The other failure class (2026-07-15) is a leaf that genuinely ended with nothing — and the damage was the *response*, not the empty result. When a **completed** leaf (its notification fired) left no work:

1. Read `results/<id>.json` and, for an isolation leaf, `git log <target>..<branch>` — confirm it is genuinely empty. (The engine now marks a leaf that died mid-stream `failed`, not `ok`, so this is usually already flagged for you.)
2. If empty, **re-dispatch a FRESH manifest name** (new run dir). If it rat-holed (a leaf sitting in a long silent thinking turn), fix the PROMPT first — add "write files as you go, commit early" and pre-resolve the one genuinely ambiguous step, so the leaf emits frequent tool calls instead of one long output-less turn.
3. **Never** kill a process, `rm -rf` a run dir, or `branch -D` a worktree branch to "clean up" — that is the operator's call alone. And never relay a leaf's self-report, or your own guess, as the cause: verify the OUTPUT (the diff, the result file), not the running process.

**Rationalisations that preceded the real incident — each is a STOP:**

| The thought | The reality |
|---|---|
| "0 writes at 49s — it's stuck / repeating the last failure" | A leaf reads for many turns before it writes. Mid-run tool counts are not health. |
| "I'll just kill it and restart clean" | There is no kill. Killing orphans the worktree and makes the resend 0s-fail. |
| "I'll `git clean` / remove the orphaned worktree / delete the branch" | Destroys salvage; it is the operator's call, never yours. |
| "It ran out of turns" / "the keepalive hook hijacked it" | A confident root cause you have not proven from the result file — proof by proxy. |
| "The `/goal` says don't pause, so I must act now" | The directive governs stalling, not interfering with a live dispatch. |

