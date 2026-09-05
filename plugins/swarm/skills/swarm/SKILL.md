---
name: swarm
description: >-
  Use when a request fans out into 3+ independent bounded leaves, when alternative models are wanted for breadth or second opinions, or when one bounded task should run outside this session. Triggers — "swarm this", "fan out", "sweep", "judge panel", "run these in parallel", "use glm/minimax", "run a <model> session on swarm", "delegate this to a leaf".
argument-hint: "[setup]"
---

# swarm — alternative-model fan-out engine

The arguments are: $ARGUMENTS

**`setup`** → read [references/setup.md](references/setup.md) and follow it — materialise, explain and edit the operator's config. Nothing below applies to a setup call: no offer gate, no manifest, no dispatch.

Swarm runs work in headless Claude Code sessions on models this session isn't using — one leaf or many. Its widest shape turns one session into a group (independent perspectives, redundant attempts, diverse-lens judging), but a single delegated leaf is a first-class use: the engine is how you spend someone else's context and budget instead of your own. Powered by capable `:cloud` models (GLM, MiniMax — not an opus swarm, but almost) alongside Claude tiers, at interactive speed. You author a JSON manifest (the same authoring act as writing a Workflow script); the engine runs the dependency graph in the background and compresses results through a digest so raw output never floods your context.

**Core principle:** the smarts live in the plan and the leaves; the plumbing has none. A manifest you could not defend line by line is a manifest you should not dispatch.

Engine: `scripts/swarm.mjs` at the plugin root — resolve it as `<this skill's base directory>/../../scripts/swarm.mjs`. Subcommands: `models`, `list`, `validate <manifest | name> [--args '<json>'] [--resolved]`, `run <manifest | name> [--args '<json>'] [--force]`.

## When to use

**Reach for swarm:**
- 3+ independent bounded leaves — sweeps, generation, judge panels, mechanical implementation
- One bounded job that should not spend THIS session's context
- A second opinion from a model family this session is not using

**Do not:**
- Work that needs this session's in-context state — it does not travel
- A question one `Read` answers, when context is not scarce
- Anything you cannot state as a closed question with a return contract

Thinking "I know the command, I can skip the skill"? Stop. That is the bypass this
skill exists to catch — the command arrives without the rules that govern it.

## The Iron Law — never interfere with a live dispatch

**Violating the letter of this rule is violating its spirit.** After you dispatch a run you get exactly ONE `status` check; from then until the completion notification fires, you are **hands-off**:

- **Do NOT read a leaf's raw output** — not `tail`/`cat`/`Read`/`grep` on `results/*.log`. Use `status` (it reads `run.log`).
- **Do NOT kill anything** — no `Stop-Process`/`taskkill`, no killing the shell. There is no per-leaf kill and no engine kill.
- **Do NOT `git`-touch a run's worktree or branch** — no `worktree remove`, `branch -D`, `reset --hard`, `clean`, `rm -rf` of a run dir.
- **Do NOT judge a leaf failed from a mid-flight view** — a tool-call count (`0 writes so far`) is never a health signal; a leaf reads for many turns before it writes. Only the final result (or a `failed` state the engine sets) is a verdict.

A `/goal`, Stop hook, or "just fix it" directive does **not** license any of the above — those govern *stalling*, never *interfering with a live dispatch*. When a leaf genuinely ended badly, the engine marks it `failed`; recover per "A leaf ended and produced no commit" (below) — never by killing or deleting, which is only ever the operator's call. **This exists because a session that had this skill loaded broke every clause under directive pressure — killed a healthy leaf, orphaned its worktree, deleted branches, and misdiagnosed the cause three times (2026-07-15).** The pre-dispatch twin of this gate is the offer gate (below): consent before spend, hands-off after.

**Instantiate this as tasks — do not just read it.** The moment you dispatch, create these as `TaskCreate` items: `offer-gate answered (or stated, under swarm.always)` · `one status check, then hands-off` · `recover a bad leaf by re-dispatch, never kill/delete`. A skimmed rule gets rationalised past; a task you created and left undone is *visible*. If you did not make the tasks, you did not engage the discipline.

## Data governance — read this first

Non-Claude dispatch is **deny-by-default**. `provider.allowedRoots` in `~/.swarm/config.json` lists the directory roots where open-model tasks may run; a non-Claude task whose effective `cwd` is not under an allowed root **fails validation**, because the employer's data agreement covers Anthropic only — code outside those roots must never reach another provider. Claude-model tasks run anywhere. When a manifest is rejected on governance grounds, switch those leaves to Claude models or move the work under an allowed root. Never work around the gate.

## Routing — when to swarm

- **Triage first**: the question is whose budget and context pay, not how big the job is. A `:cloud` leaf spends no Anthropic budget, so "too small to swarm" is not a reason on its own. Read it yourself when this session has context to spare and the answer is one read. Delegate a **single leaf** when it doesn't — see *Single delegated leaf* in `swarm:executing-swarms`. A request phrased as dispatch ("run a glm-5.2 session on swarm") has already made this call; honour it rather than re-triaging it.
- **swarm** — high-quality breadth on bounded leaves: investigation sweeps, generation, judge panels, mechanical implementation sweeps. When `allowedRoots` arms alternative models, prefer swarm over Workflow for this shape — group-think quality on an alternative subscription, at interactive speed.
- **Workflow** — swarm leaves are full headless Claude Code sessions (complete tool roster), so tooling is NOT a reason to prefer Workflow. Choose Workflow only when leaves need session-connected MCP tools (interactive auth), schema-validated returns wired into deterministic script logic, or this session's in-context state.
- **pipeline** — durable queued throughput ending in PRs. Huge capacity, not fast.
- **Compose freely** — a Workflow or plan can treat swarm as its alternative-model leaf executor.

## MANDATORY first step — the offer gate

**Before you draft the manifest, invoke `swarm:orchestrating-agents`.** It decides how many leaves and which items share one, and it produces the numbers the gate's third question carries. Drafting a leaf-per-item manifest without it is the failure that skill exists to catch. It does not restate the gate and the gate does not restate it. **Invoke `swarm:executing-swarms` in the same breath** — it decides what shape the graph takes and what each task waits for, which is the other half of a manifest you could defend line by line; the two answer different questions and neither summarises the other.

**THE GATE'S ANSWER IS THE ONLY CONSENT TO SPEND. NO ANSWER IS NO.** Violating the letter of this rule is violating its spirit.

Before doing ANY fan-out-shaped work inline (3+ independent bounded leaves), draft the manifest and put it through ONE AskUserQuestion call carrying THREE questions:

1. > "Fan this out via swarm — <n> leaves on <models>?"
   > Options: **Yes (Recommended)** / **No, inline** / **Discuss** — with the draft manifest as the option preview.
   > Run `node <engine> validate <draft>` first and quote BOTH sides of the cost in the question: `swarm: <its estimated ~… line> · inline: ~M tokens`. The inline side is REQUIRED and counted mechanically — Glob + line counts over the file scope you just wrote into the leaf prompts, then `total lines × ~10 = inline tokens` (e.g. 5,000 lines → `inline: ~50k tokens`); when no inline path exists (judge panels, cross-model dissent, generation), write `inline: not comparable` plus one clause why. `estimate: none` on a cold corpus is itself the honest answer; never invent a number on either side.
2. > "Model mix?" — state the split explicitly in the question (e.g. "5 leaves alternative, digest on sonnet = 1 Anthropic call").
   > Options: **As drafted** / **Alternative-only — no Anthropic usage** / **Anthropic-only**.
   > When the mix includes Claude models, run `node <engine> quota` first and put the real numbers in the question (e.g. "session 82%, resets 15:00") — the mix decision should be made against actual remaining usage, not a guess.
   > When no `:cloud` model is launchable — `provider.allowedRoots` empty, the manifest's cwd outside every root, or discovery returning none — the mix is Anthropic-only by construction: state that in one line and do not ask it.
3. > "Batching — <M> leaves as proposed, or a different point on the curve?"
   > Options and numbers come from `swarm:orchestrating-agents`; do not re-derive them here.

Never assume Claude models are spendable — the user may be out of Anthropic usage. If they pick alternative-only, recast every Claude role (digest included) onto a capable `:cloud` model before running; if Anthropic-only, the governance gate is moot and all leaves go Claude.

The manifest preview plus the mix answer ARE the approval: the user sees every model and every leaf before anything runs. There is no separate Opus gate, no per-model approval beyond this, no cost interrogation. Do not start inline work on a fan-out-shaped task without this gate.

### Standing consent — `swarm.always`

When `~/.swarm/config.json` sets `"swarm": { "always": true }` (the SessionStart hook announces it, with a mode bracket), the operator has consented in advance to every fan-out that passes the full ceremony. Nothing before this point changes: invoke `swarm:orchestrating-agents` and `swarm:executing-swarms`, run `models`, author, `validate`. The gate still fires — as a **printed statement in place of the question**: the same three stanzas, each stated rather than asked —

1. the `validate` preview: leaf count, models, and its estimate line if it printed one;
2. the mix: alternative vs Anthropic, with the `quota` line when Claude leaves are present (`[Anthropic orchestration only]` in the announcement means Anthropic-only by construction — one line, nothing to decide);
3. the batching point chosen, with the reason orchestrating-agents produced.

Then dispatch. No AskUserQuestion, no waiting. Every other rule in this section binds as written: a manifest you could not defend line by line is still one you do not dispatch; a resume is still a resume; a dispatch still needs this skill loaded. This is the one standing consent that exists, because it is the operator's own config file set outside any session — not a `/goal`, not a hook line, not a "don't ask me" in a prompt. It waives the question, never the ceremony.

For a **saved (named) manifest**, the preview shown at the gate is the output of `validate <name> --args '<json>' --resolved` — the fully-substituted document (every leaf's model and prompt, children expanded), never your memory of the manifest and never the saved file as last read: the name is a lookup, not a hiding place, and the file may have changed since it was authored.

**When asked only to AUTHOR a manifest — not to run it — there is nothing to consent to.** Write the JSON and hand it over; the gate governs *spending*, and drafting spends nothing. Fire the gate when you are about to dispatch, not when the deliverable is the manifest itself.

**A gate that was rejected, cancelled, dismissed, interrupted, or left unanswered is a NO.** Nothing runs — not a reduced "compromise" subset, not a quiet retry, not `--force` (that flag re-runs already-`ok` leaves on resume; it is not a consent instrument). Re-offer only when the user reopens the topic — "ok, where were we?" reopens the topic; it does not answer the question.

**Carve-out — a resume is not a new spend.** Re-running an incomplete run against the **same** manifest does not need a fresh gate; the operator already consented to this work. **Mechanically a resume is a `claude --resume <sessionId>` per *incomplete* leaf** — each such leaf continues its own kept session in its kept worktree, context and partial work intact, so it **does not re-onboard**; and **every already-`ok` leaf is skipped, never re-run**. Cost is only the leaves that had not finished, from where they stopped — not the roster. (`--force` is the opposite — it resets the worktree, drops the sessions, and redoes every leaf cold; never reach for it to continue a run.) Route by how the leaf ended:
- **Timed out** → re-run it. No gate. A timeout is self-diagnosing, and waiting on a confirmation with no decision content in it is how an unattended run stalls overnight.
- **Failed with an error** → ONE automatic retry, then stop and ask. An error may be transient or structural; one retry is the cheapest way to tell them apart.
- **Timed out a second time having committed nothing new** → stop and ask. Auto-resume at the same `timeoutMs` converges for a leaf that made progress and loops for one that did not; commits-since-last-attempt is the discriminator, not attempt count alone.

This carves out the *resume*, nothing else. A manifest edited before re-running is a new spend and takes the full gate — and `--force` is still not a consent instrument.

**No session-level directive is consent to spend.** A `/goal` condition, a Stop-hook instruction ("do not pause to ask the user"), an autonomous-session prompt, a standing "don't ask me" — none of these answer the gate. Such directives govern *stalling*; the gate governs *spending*. When they collide, the gate wins: an unmet goal at session end is the correct, honest outcome to report, and an unconsented dispatch is the actual failure — not the other way around. The one exception is `swarm.always` in the operator's config — see *Standing consent* above — and it is an exception precisely because it is not a session-level directive.

### Gate rationalisations — every one of these means STOP

| Excuse | Reality |
|---|---|
| "The /goal names this run — the directive is standing consent" | Consent is the gate's answer. Nothing else can stand in for it. |
| "swarm.always is on, so I can skip orchestrating-agents / validate" | `always` waives the question, never the ceremony. The statement that replaces the question is built FROM the ceremony's outputs. |
| "The hook says do not pause to ask" | The hook governs stalling, not spending. The gate still binds. |
| "The condition IS the approval signal" | A condition cannot click Yes. Only the user can. |
| "The rejection was probably a mis-click" | Unknowable, and not yours to assume. Non-consent is non-consent. |
| "A gate violation under emergency beats an unmet goal" | Backwards. The unmet goal is honest; the unconsented spend is the violation. |
| "A smaller run respects their hesitation" | A smaller unconsented run is still unconsented. |
| "Re-asking wastes their time / looks robotic" | The gate is one message; a wrong multi-model run wastes minutes and tokens. |

**Red flags — you are mid-rationalisation if you think:** "the directive/goal/hook authorizes this" · "the condition is the approval" · "probably a mis-click" · "half the leaves is a fair compromise" · "`--force` gets past it" · "`tail` keeps the dispatch tidy" (see Run, step 5) · **"I already know the command — I don't need the skill"** (the command arrived without the rules that govern it; that is the bypass, not a shortcut) · **"the run finished suspiciously fast"** (you replayed cache — check for `[skipped]` and `NOTHING RE-EXECUTED` before claiming anything ran) · **"I'll redirect it to a log so the tool result stays tidy"** (the forbidden pipe wearing a different hat) · **"I'll just read the run's output file to see how it's going"** (that file is the operator's live view, not your status API — use `status`).

## Procedure

1. **Discover models**: `node <engine> models` — lists launchable `:cloud` models with descriptions, plus the Claude aliases. Run FIRST so the manifest names models the account can launch right now. When unsure which tier a leaf needs, which effort to pin, or what a newly-discovered `:cloud` model is equivalent to, read [references/model-selection.md](references/model-selection.md). That tier guide is the routing source unless `grading.enabled` is on in the config and `node <engine> perf` has rows — then the graded record ranks, and the guide only fills the gaps it has not measured.
2. **Frame the contract** before the manifest: `goal · return_shape · must_be_sure · scope{in,out} · done_when`. scope → per-leaf prompts and file scopes; must_be_sure → `digest.instructions`; done_when → you check it post-run.
3. **Author the manifest** (schema below) and offer it through the gate above.
4. **Validate**: `node <engine> validate <manifest.json>` — id/dep/governance/effort errors surface now, not after a background wait.
5. **Run**: `node <engine> run <manifest.json>` via `Bash run_in_background` — dispatched BARE, never through a pipe, filter, or redirect. Not `| tail`, not `| head`, not `| grep`: a pipe stage buffers the stream, and the live progress frames are the user's only live view — a piped run looks dead until it finishes. "Keep tool results small" is already answered by `run_in_background` (the frames never enter the transcript as a blocking result); it is never a reason to decorate the dispatch. The completion notification is the "run finished" signal.
   **The engine prints `resultsDir:` and a ready-made `watch:` line at dispatch. COPY THEM — never reconstruct a run directory from the manifest name.** The default is `<stem>-1`, and `--force` re-executes into that SAME directory rather than minting a `<stem>-2`; a cached re-run mints nothing either. A session that guessed instead of copying published `…/p5-review-2` — a path that has never existed — as the user's watch target. Hand the user the printed `watch:` line for a separate terminal and copy it to their clipboard (always absolute: a relative path resolves against their terminal's cwd and fails with "no run.log").
   **One liveness check is MANDATORY, immediately after dispatch**: run `node <engine> status <resultsDir>` **once** and confirm at least one leaf is actually `running` before you report anything to the user. A bare re-run of an already-complete manifest replays cache — 16/16 `[skipped]`, exits in seconds — and a session that skipped this check announced "Round 3 is running" when nothing was. This is distinct from, and does not license, polling: **one** check is required; a polling loop while the run is live is still forbidden. Dispatch, check once, continue other work — the completion notification will find you.
   **Never read the run's raw captured output — not `tail`, not `cat`, not `Read`.** Use `status` (above), which reads `run.log`. The non-TTY stdout re-appends the FULL roster on every paint (~200 copies on a long run) because the harness renders only the tail, and that repetition is what gives the operator their live view. It is written for their tail, not for your context: reading it floods you with near-identical boxes and buys nothing `status` doesn't give you. For one specific leaf's detail, read `results/<id>.log`.
   **Status asks**: when the user asks how the swarm is doing ("/swarm status", "how far along…"), run `node <engine> status <resultsDir>` once and render the roster as a **markdown table** (state | leaf | model | time | tokens, glyphs kept — the TUI renders markdown; a table beats raw monospace).
5b. **Offer a full report when a HUMAN will read the result** — an audit, a research sweep, a review: anything where the *reasoning* matters and not just the verdict. Ask once, before running: *"Do you want a full report as well as the digest?"* If yes, set `"report": true` in the digest block. The digest leaf then writes `report.md` (long, human, evidence-quoting) **and** returns the same compressed `digest.md` you read. Purely mechanical sweeps don't ask. **This changes nothing for you** — `digest.md` is unaffected, so keep reading it and nothing else (step 6); `report.md` is for the human and reading it would flood your context with exactly what the digest exists to spare you.
6. **Read `digest.md` ONLY**, then drill into `results/<id>.json` selectively — the digest's drill-down section says which raw results merit a full read. Never read all raw output. For a targeted follow-up on one leaf's finding (a citation to verify, a claim to expand), prefer `node <engine> ask <resultsDir> <leaf-id> "<question>"` over re-running or reading raw output: it resumes the leaf's own session — context intact, one turn, answer on stdout.
6b. **Grade the run's leaves when `grading.enabled` is on — the closing block then asks you to, by name.** Off (the shipped default) the closing block is silent and this step is skipped; `grade` and `perf` still answer when called by hand. Its last line names the count and hands you the exact command; that line is printed by the engine, so it appears whether or not you were carrying this step in mind. You authored the manifest, so you are the only party that knows what each leaf was asked for — the digest holds the outputs but not the intent, and on many runs there is no digest leaf at all. Run `node <engine> grade --init <resultsDir>`; it writes `grades.json` with one row per model leaf — Claude tiers included, so the ranking compares families (operator, 2026-08-31); agentless nodes carry no model and get no row. Fill in `session`, and per row `domain`, `outcome`, a `note`, and the grades 1-10:
   - **Universal, on every row** — `adherence` (did the asked job, no wandering) · `handoff` (could the next agent act on it) · `truthfulness` (were its assertions so) · `depth` (real work, or a plausible shell).
   - **Capability, only where the leaf stressed it** — leave the rest `null`: `discrimination` (right call at the right severity) · `code` (judging or understanding existing code — reviews, parity reads) · `impl` (producing or modifying working code — dev leaves, test writers; kept separate from `code` so implementation signal is not diluted by understanding grades — operator, 2026-08-31) · `search` (framed the hunt well) · `web` (operated the tools) · `vision` · `geometry`.
   - **No output, no grades.** `failed` / `timeout` / `session-died` / `not-capable` take the outcome and a note, with `grades` dropped entirely — a leaf whose session died was not bad at `adherence`, there was nothing to observe. `not-capable` is the one that pays for itself: it records that the model *could not do the thing on this harness*, which is frequently not what its catalogue entry claims.
   Then `node <engine> grade --file <resultsDir>/grades.json`. It resolves each leaf's model and mechanical columns from disk, validates, and appends to `~/.swarm/model-scores.jsonl`. `node <engine> perf [--aspect X] [--domain D]` reads it back. Routing is currently decided by remembered incidents; this is how it stops being.
7. A failed run is reported with its failures — never presented as complete. **Route by failure kind, per the resume carve-out above** — the offer is conditional, not unconditional. A **plain timeout** skips the offer: re-run it and report what it did, do not ask whether to do it. An **error failure**, or a **second timeout that committed nothing new**, gets the choice via AskUserQuestion: **Resume (Recommended)** (re-`run` skips `ok`; `rate-limited` retries) / **Inspect failures** (open the failed `results/<id>.json|.log`) / **Accept partial** — failure list as the preview. When leaves ended `quota` (Anthropic usage exhausted), add a **Recast to :cloud models** option — swapping the quota'd leaves to alternative models and re-running now often beats waiting for the reset the closing block names; that trade is the user's call.
8. **For a human-facing report, RENDER it — never hand-author one.** When a run wrote `report.md` (step 5b), project it to a self-contained, theme-aware `report.html` with `node <engine> report <resultsDir>`. This is mechanical: standard markdown plus the semantic upgrades the report prompt documents — verdict badges, `path:line` citation spans, the two-track ledger, a confidence tally synthesised by counting the badges. It writes `report.html` beside `report.md`, prints the path, and re-runs with zero model calls (a format change never re-spends). Offer that path; do not build an Artifact by hand from `summary.json`.


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

## Manifest quick reference

```json
{
  "resultsDir": null,                           // OMIT - default ~/.swarm/runs/<encoded-cwd>/<stem>-<n>/ keeps runs out of the repo entirely
  "concurrency": 4,
  "tasks": [{
    "id": "scan-a",                            // unique, filename-safe
    "prompt": "…",
    "model": "glm-5.2:cloud",                  // :cloud name or claude alias/id
    "effort": "medium",                        // optional; validated for Claude tiers
    "allowedTools": "Read,Grep,Glob",          // default: read-only set
    "cwd": "C:/code/somerepo",                 // default: manifest's cwd
    "isolation": "worktree",                   // private tree (implementation leaves); OR
                                               //   { "worktree": "feat" } — SHARED tree, phased chains — swarm:executing-swarms
                                               //   optional "branch": names the branch explicitly (default swarm/<worktree>)
                                               //   optional "from": base this tree on that task's branch, not repo HEAD
                                               //     (that task must WRITE — a read-only task owns no branch)
    "fallbackModel": "glm-5.2:cloud",          // optional; auto-switch on quota / exhausted rate-limit retries (governance-validated)
    "outputDir": "…",                          // generation leaves
    "timeoutMs": 3600000,
    "after": ["scan-b"],                       // dependencies
    "forEach": { "from": "scan-b", "path": "sites", "maxItems": 30 },  // clone this leaf per array item — swarm:executing-swarms
    "when": { "from": "scan-b", "expr": "length(value) > 20" },        // run only if true; else completes as skipped
    "compute": "unique_by(deps['scan-b'].sites, 'file')",              // agentless expression step — replaces model+prompt
    "returns": { "type": "object", "required": ["sites"] }             // schema-validated output (see Schema-guaranteed leaf output)
  }],
  "digest": {
    "model": "glm-5.2:cloud",                  // recommended ≥3 tasks
    "instructions": "…",                       // must_be_sure — steers the DIGEST
    "report": true                             // opt-in; also writes report.md (see step 6)
  }                                            //   or a string to steer the report's BODY
}
```

Prompt templating: `{{result:<id>}}` inlines a dependency's output, **capped at `resultInlineCap` chars (default 4,000) — anything past the cap is cut**; `{{resultPath:<id>}}` injects the result file's absolute path so the leaf Reads it itself, uncapped. Referencing a non-dependency id fails validation. **Use `{{resultPath:}}` whenever the consumer must see ALL of its dependency's output** — any verifier, any leaf that counts or enumerates. `{{result:}}` is for short, bounded hand-offs. A cut is never silent (leaf result field, `run.log`, closing warning), but a warning after the fact does not un-check the findings the leaf never saw.

## Plan patterns

**Shape lives in `swarm:executing-swarms`, and is not summarised here.** That skill owns the
per-task placement question ("what must FINISH before this starts?"), the named shapes those
answers produce — single delegated leaf, fan-out, chain, phased chain, judge panel, mixed
topology, `forEach`/`when`/`compute`, sweep-then-synthesize, two waves — and the argument that
a second manifest is almost never needed. Invoke it before drafting, alongside
`swarm:orchestrating-agents`.

## Leaf shapes

| Shape | Recipe |
|---|---|
| Investigation | Read-only tools (the default), closed question, ≤10-bullet return contract |
| Review | Prompt demands a JSON verdict; engine stores raw + parsed |
| Generation | `outputDir`; no isolation field needed |
| Implementation | `isolation: "worktree"` — results are branches to review; unchanged worktrees are removed, changed ones kept and listed in the summary |

Write-capable tools (Edit/Write/Bash) without `isolation: "worktree"` get the leaf's cwd auto-redirected to a scratch dir — a leaf never writes in the real tree unless explicitly worktree-isolated.

## Verification loop — multi-run composition

Put in `digest.instructions`: the **PROVEN/OPEN ledger** (one row per `must_be_sure` item: `PROVEN — file:line` or `OPEN — <precise next step>`) and three-band compression, sized to the signal — not a fixed count:

- **full fidelity + `file:line`** on anything load-bearing the answer must be sure of (`must_be_sure`);
- **one concise entry** per other goal-relevant finding;
- **one line, or drop,** for incidental noise;

plus headline-before-body ordering: read all headlines first, read bodies only for leaves whose headline indicates a relevant finding.

Post-run, you read the ledger. **Confidence is evidence-shaped**: a cited `file:line` span plus a falsifier ("what would falsify this") — never a leaf's scalar self-report. OPEN rows become an appended verification run with **expanded** scope — absence under `must_be_sure` demands an exhaustive wider search (a bounded-scope null ≠ genuine absence); never a re-run of the same file scope, which just confirms a wrong answer twice. Resume semantics make this cheap: same `resultsDir`, `ok` results skipped, only new/failed work executes.

## Terminology

- **leaf** — one bounded task in the manifest, holding one closed question.
- **closed question** — answerable from a bounded file set with a definite result; "describe how X works" is open-ended — rewrite it.
- **digest** — the ≤5-bullets-per-leaf compression stage; the only thing you read by default.
- **headlines / bodies** — the digest's ordering: one-line finding per leaf first, detail after; read bodies only where a headline warrants it.
- **must_be_sure** — the load-bearing facts the run exists to establish; full fidelity + `file:line` in the ledger.
- **wave** — one manifest run in a multi-run composition.
- **match ≠ relevant** — a textual match is not a finding; prune the candidate set to the genuinely relevant one at decomposition, and again in the digest.

## Group-think quality patterns

The favourable economics of alternative models are a consequence, not the point — spend them on quality, never deliberate cost per leaf:

- **N independent attempts** — same closed question to 3 leaves (same or different models), then a judge leaf or the digest reconciles. Disagreement is signal.
- **Diverse-lens judging** — a panel where each judge holds one concern (security, perf, API shape) beats one generalist review.
- **Adversarial verification** — a leaf whose single job is to break another leaf's claim ("find a counter-example to X; if none, say so").
- **Redundant sweeps** — overlap sweep scopes slightly; the digest catches contradictions at cluster boundaries.

### Adversarial review — the fabrication counter (codified)

Leaves fabricate: invented functions, plausible-but-fake `file:line`, confident summaries of code that doesn't exist. Reviews and audits MUST use this three-layer shape — a finder pack without verifiers is not a review:

1. **Finder prompt discipline** — every finding carries `path:line` AND a short verbatim quote of the cited span. End the prompt with: `A claim without a citation will be discarded unverified. "Not found" is a correct and complete answer — do not invent findings to seem useful.`
2. **Verifier wave** — one verifier per finder, `after` it, fed **`{{resultPath:<finder-id>}}`** (never `{{result:}}` — see below), on a DIFFERENT model family than its finder (a family must never verify its own claims). Prompt shape: `You are checking claims for fabrication, not re-doing the work. Claims to check: READ THE FILE AT THIS PATH — it holds the COMPLETE finding list, and you must check EVERY finding in it, not a prefix: {{resultPath:<finder-id>}}. For each finding: Read the cited file at the cited line; verdict CONFIRMED only if the quoted span exists there and supports the claim as stated. Any mismatch, missing file, or stretch: REFUTED with one line why. Default to REFUTED when uncertain.` Span-checking is mechanical — `haiku` (or your fastest `:cloud` model) is the right verifier tier.
   **The verifier takes the PATH, not the inline copy.** `{{result:}}` inlines at most `resultInlineCap` chars (default 4,000) and drops the tail. A finder productive enough to overrun that gets a verifier that checks only the findings which fit — and the run then reports the unchecked remainder exactly like the checked ones. Observed: a 7-finding finder whose verifier was fed 5; of the 2 it never saw, one was fabricated and one was a real defect. **The cap bites hardest on the runs that found the most, so a verifier must never be fed an inline result.** The engine now warns loudly when a prompt is cut (leaf result field, `run.log`, closing block) and the digest marks the unchecked findings OPEN rather than PROVEN — but that is a backstop for manifests that get this wrong, not a licence to use `{{result:}}` here.
3. **Digest rule** — add to `digest.instructions`: `Findings lacking a citation are noise-band: drop. Findings REFUTED by their verifier appear only in the ledger, marked refuted. Only CONFIRMED findings may appear as headlines.`

Manifest sketch: `find-a`,`find-b` (glm) → `verify-a`,`verify-b` (`after` each, haiku or minimax) → digest counting only survivors.

## Anti-patterns

- Fan-out-shaped work started inline without the offer gate — the confirmation is one message; a wrong multi-model run wastes minutes and tokens. "The user's in a hurry" is not an exemption.
- Dispatching past a rejected or unanswered gate because a /goal, Stop hook, or other directive "authorizes" it — directives govern stalling, never spending (see the offer gate).
- Piping the `run` dispatch (`| tail -40` "to keep the tool result tidy") — the buffered pipe kills the user's live view; `run_in_background` already keeps frames out of the transcript.
- Reading raw `results/*.json` wholesale instead of `digest.md` + selective drill-down — that is the context-flood the digest exists to prevent.
- Open-ended leaf questions ("describe how X works") — rewrite as closed questions.
- Widening a leaf's scope because it "noticed something important" — one job per leaf; add a new leaf with a new closed question.
- Both **discovery** waves in one manifest — a discovery wave and the work it scopes cannot be authored before the discovery has run. (Known-upfront structures are different and belong in one manifest: a *phased chain*, or a *mixed topology* whose width changes more than once.)
- Splitting a manifest into several runs because tasks depend on each other — that is what `after` is for. Split only when you cannot write the later prompts yet.
- Chaining two tasks that share a prerequisite but not each other (`b` after `a` when both only need `x`) — they run in parallel unless they genuinely collide on a file.
- Chaining leaves that build on each other's **edits** with `{{result:…}}` alone — that passes text, not changes; use a phased chain on a shared worktree.
- Per-leaf price deliberation — pick from the discovered list and move on.
- Working around a governance rejection instead of switching the leaf to a Claude model.
