# Model selection for swarm leaves

Every task in a swarm manifest pins a **model** and, optionally, an **effort**. Model choice is a quick pick from the measured record, not a ceremony: the point of swarm is quality from group-think — many capable perspectives, redundant attempts, diverse-lens judging — and the alternative subscription means you spend on redundancy and judgement, never on per-leaf price deliberation.

> Adapted from /deep's model-selection reference. Deep's Workflow/conductor dispatch split does not apply here — swarm dispatches every leaf via CLI, so per-task `effort` is always honoured. What carries over is the tier/effort reasoning, which is general.

With grading enabled, `swarm.mjs perf` is the record and this guide covers only what it has not measured. Run `swarm.mjs models` first — it lists the `:cloud` models the account can launch right now, plus the always-available Claude aliases, each annotated with its meter weight and a `*` when it sits on the cost frontier.

## How to pick: read the frontier, never compute a ranking

Quality and cost are two axes and **never collapse into one number**:

- **`swarm.mjs perf`** owns quality — per-aspect weighted scores, and `--overall` the one combined ranking.
- **`swarm.mjs cost`** owns cost — each measured model's meter weight relative to the cheapest well-measured model, derived from the history every live usage fetch banks.
- The **frontier** joins them: a model is on it when no other model is both higher-scoring *and* cheaper. In `perf`, `dom <model>` marks a dominated model — one that is better AND cheaper exists — and a dominated model is never worth seating. A model rendering `—` is **unmeasured, not free and not dominated**: the history has not priced it, and absence is not evidence in either direction.

The seating rule is the method, not a list:

1. Read `perf --overall` and `cost` together.
2. Seat from the frontier — the best-scoring model that is not dominated. A dominated model always has a strictly better-and-cheaper replacement; take the replacement.
3. When the leaf's job needs a capability class nothing on the frontier has shown — cross-file architectural reasoning, subtle synthesis — seat the Claude tier named below. Claude tiers are unmeasured by the ollama meter by design: their cost lives on the Anthropic subscription, so they render `—` and neither dominate nor are dominated.
4. Never re-rank by hand, and never as quality÷cost. The shrinkage prior floors every model near a common score, so a ratio mostly measures the denominator — cheapness — and has been observed to put a one-graded-leaf model on top. The frontier is computed from the banked evidence by the tool; read it.

A fresh install has no history: every model renders `—`, the frontier is empty, and the tier guide below is the whole guide until the meter record fills — which happens by itself within a week of normal use.

## Tier guide

- **`:cloud` alternative models** — capable on bounded reasoning leaves. **The default for bounded leaf work**: investigation sweeps with a closed question, structured extraction, fixed-lens reviews, mechanical implementation, generation, digesting. This is what makes group-think patterns affordable to run wide — reserve Claude tiers for final synthesis and subtle judgement.
- **`haiku`** — existence checks, file listing, "does this symbol appear?", deterministic JSON extraction, one-line annotations. Fast, weak at independent reasoning. **Avoid when the leaf must synthesise or reason** — Haiku pattern-matches the prompt's examples instead of doing the work.
- **`sonnet`** — the Claude floor for any leaf that must understand code, reason about patterns, trace a flow, or produce structured findings. Single-cluster judgement.
- **`opus`** — cross-file architectural reasoning, behavioural-equivalence constraints, multi-branch impact assessment one leaf must hold in its head at once. The ceiling for cross-cutting questions. A leaf that genuinely needs Opus is often a sign the question wasn't decomposed enough — check before reaching for it.

If you decomposed correctly, most leaves answer a *bounded, closed* question over one cluster — that's `:cloud`-model or sonnet territory. Within the Anthropic subscription the cost order is a consequence of the tier split (never the reason a leaf is picked): `:cloud` < `haiku` < `sonnet` < `opus`. Within the ollama meter there is no order to memorise — that is `swarm cost`'s job, and it changes as the history accumulates.

## Choosing effort given model

Swarm has no fixed roles: you invent the cast per manifest, so **derive each leaf's effort from its job**, exactly as you pick its model. Effort fine-tunes reasoning depth once the model is picked — and the same model at higher effort is often better than jumping a tier:

- **`sonnet`+max** often reasons better than **`opus`+low** when the bottleneck is reasoning depth, not raw capability.
- **`haiku`+max** can match **`sonnet`+low** for mechanical-with-judgement work.
- The same applies to sonnet-class `:cloud` models: raise their effort before promoting the leaf to a Claude tier.

**Key principle: escalate effort within a tier before jumping tiers.**

### Effort levels (low→max)

- **low** — quick mechanical work (existence checks, file listing, symbol locations)
- **medium** — balanced reasoning; the fallback when the leaf's job gives no strong signal either way (not a blanket default)
- **high** — cross-file invariants, multi-step traces, structured findings that must be right
- **xhigh** — hard cases between high and max; rare
- **max** — depth-bound reasoning; you've tried shallower and it wasn't enough

### Per-tier supported effort levels

Claude tiers reject unsupported levels; `swarm.mjs validate` checks the pairing at manifest load, not runtime.

| Tier | Supported levels | Notes |
|---|---|---|
| `:cloud` models | any | `--effort` passes through; honoured where supported, harmlessly ignored upstream otherwise |
| `haiku` | `low`, `medium`, `high` | no `xhigh`, no `max` |
| `sonnet` | `low`, `medium`, `high`, `max` | no `xhigh` |
| `opus` / `fable` | `low`, `medium`, `high`, `xhigh`, `max` | full scale |

## Context window

The 1M context window (`disable1mContext: false` in config, or a task's `settings` override) is a wall-clock lever, not a quality one — measured ~+45% cost for the same output, same quality. Shipped default is off (200k).

## Approval

There is no Opus gate and no per-model approval in swarm: the manifest preview in the offer gate is the single confirmation artefact — the user sees every leaf, model, and effort before anything runs. If the user swaps a model in review, that's the decision; don't argue.

## Anti-patterns to refuse

- **Defaulting Haiku for analysis.** Haiku is for mechanical lookups; asking it to "be skeptical" or "synthesise" yields template-imitation, not analysis.
- **Reserving `:cloud` models for throwaway work.** They are sonnet/opus-lite-class on bounded leaves — casting them only for trivia forfeits the group-think breadth that is the product.
- **Claude tiers on every leaf out of habit.** Final synthesis and subtle judgement, yes; bounded closed-question leaves, no.
- **Ranking by quality÷cost.** The ratio is the exact failure the frontier exists to replace — it ranks cheapness and lets one thin cheap sample head the list.
- **Reading `—` as "free" or as "dominated".** Unmeasured is unmeasured; seat a `—` model on quality evidence, never on an imagined price.
- **Pinning an unsupported effort on a Claude tier** — `validate` rejects it at load; fix the pairing, don't drop the effort silently.
- **Jumping tiers before trying effort.** Reach for `sonnet`+high before `opus`+low; raise a `:cloud` model's effort before promoting the leaf.
- **Per-leaf price deliberation.** Read the frontier, pick from the list, move on — spend the favourable economics on redundant attempts and judge panels, not on choosing ceremony.