# Model selection for swarm leaves

Every task in a swarm manifest pins a **model** and, optionally, an **effort**. Model choice is a quick pick from the measured record, not a ceremony: the point of swarm is quality from group-think — many capable perspectives, redundant attempts, diverse-lens judging — and the alternative subscription means you spend on redundancy and judgement, never on per-leaf price deliberation.

> Adapted from /deep's model-selection reference. Deep's Workflow/conductor dispatch split does not apply here — swarm dispatches every leaf via CLI, so per-task `effort` is always honoured. What carries over is the tier/effort reasoning, which is general.

With grading enabled, `swarm perf` is the record and this guide covers only what it has not measured. Run `swarm models` first — it lists launchable rows from enabled providers, keeps provider identity visible, and annotates provider-local meter evidence where available.

The seating rule is the method, not a list:

1. Read `perf --overall` and `cost` together.
2. Seat from the frontier — the best-scoring model that is not dominated. A dominated model always has a strictly better-and-cheaper replacement; take the replacement.
3. When the leaf's job needs a capability class nothing on the frontier has shown — cross-file architectural reasoning, subtle synthesis — seat the matching Claude tier.
4. Never re-rank by hand, and never as quality÷cost. The shrinkage prior floors every model near a common score, so a ratio mostly measures the denominator — cheapness — and has been observed to put a one-graded-leaf model on top. The frontier is computed from the banked evidence by the tool; read it.

Claude tiers are unmeasured by the ollama meter by design: their cost lives on the Anthropic subscription, so they render `—` and neither dominate nor are dominated.

## Choosing effort given model

Swarm has no fixed roles: you invent the cast per manifest, so **derive each leaf's effort from its job**, exactly as you pick its model. Effort fine-tunes reasoning depth once the model is picked — and the same model at higher effort is often better than jumping a tier:

- **`sonnet`+max** often reasons better than **`opus`+low** when the bottleneck is reasoning depth, not raw capability.
- **`haiku`+max** can match **`sonnet`+low** for mechanical-with-judgement work.
- The same applies to sonnet-class registered models: raise their effort before promoting the leaf to a Claude tier.

**Key principle: escalate effort within a tier before jumping tiers.**

### Effort levels (low→max)

- **low** — quick mechanical work (existence checks, file listing, symbol locations)
- **medium** — balanced reasoning; the fallback when the leaf's job gives no strong signal either way (not a blanket default)
- **high** — cross-file invariants, multi-step traces, structured findings that must be right
- **xhigh** — hard cases between high and max; rare
- **max** — depth-bound reasoning; you've tried shallower and it wasn't enough

### Provider-declared effort levels

Every dispatching leaf receives an explicit effort; `manifest-fields.md` → "Effort"
owns how one is resolved and when `swarm validate` rejects it. Run `swarm models`
to see each model's declared efforts.

## Context window

The 1M context window is a wall-clock lever, not a quality one — measured ~+45% cost for the same output, same quality. Shipped default is off (200k). For the `:cloud` manifest field and model caveats, read `manifest-fields.md` → `contextWindow`; Claude-model leaves use `disable1mContext` / `CLAUDE_CODE_DISABLE_1M_CONTEXT`.

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
