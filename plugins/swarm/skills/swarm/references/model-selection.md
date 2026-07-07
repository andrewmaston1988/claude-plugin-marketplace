# Model selection for swarm leaves

Every task in a swarm manifest pins a **model** and, optionally, an **effort**. Model choice is a quick pick from the discovered list, not a ceremony: the point of swarm is quality from group-think — many capable perspectives, redundant attempts, diverse-lens judging — and the alternative subscription means you spend on redundancy and judgement, never on per-leaf price deliberation.

> Adapted from /deep's model-selection reference. Deep's Workflow/conductor dispatch split does not apply here — swarm dispatches every leaf via CLI, so per-task `effort` is always honoured. What carries over is the tier/effort reasoning, which is general.

Run `swarm.mjs models` first — it lists the `:cloud` models the account can launch right now, each with a description, plus the always-available Claude aliases.

## Tier guide

- **`:cloud` alternative models** (glm, minimax, qwen, …) — capable, near-Claude-quality on bounded reasoning leaves. **The default for bounded leaf work**: investigation sweeps with a closed question, structured extraction, fixed-lens reviews, mechanical implementation, generation, digesting. This is what makes group-think patterns affordable to run wide — reserve Claude tiers for final synthesis and subtle judgement.
- **`haiku`** — existence checks, file listing, "does this symbol appear?", deterministic JSON extraction, one-line annotations. Fast, weak at independent reasoning. **Avoid when the leaf must synthesise or reason** — Haiku pattern-matches the prompt's examples instead of doing the work.
- **`sonnet`** — the Claude floor for any leaf that must understand code, reason about patterns, trace a flow, or produce structured findings. Single-cluster judgement.
- **`opus`** — cross-file architectural reasoning, behavioural-equivalence constraints, multi-branch impact assessment one leaf must hold in its head at once. The ceiling for cross-cutting questions. A leaf that genuinely needs Opus is often a sign the question wasn't decomposed enough — check before reaching for it.

If you decomposed correctly, most leaves answer a *bounded, closed* question over one cluster — that's `:cloud`-model or sonnet territory. Cost order, a consequence of the subscription split (never the reason a leaf is picked): `:cloud` < `haiku` < `sonnet` < `opus`.

## Claude-tier equivalence table (user-maintained)

Seeded from the user's own calibration; refine as models change:

| Alternative model | ≈ Claude tier | Notes |
|---|---|---|
| `minimax-m3:cloud` | sonnet-class | reasoning-leaf default; honours `--effort` |
| `glm-5.2:cloud` | opus-lite | heavier synthesis and judging on the alternative subscription |

When a new model appears in discovery, judge its tier from the `models` output's per-model description (positioning, context length) and a trial leaf — then add a row here once calibrated.

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
| `:cloud` models | any | `--effort` passes through; honoured where supported (e.g. minimax), harmlessly ignored upstream otherwise |
| `haiku` | `low`, `medium`, `high` | no `xhigh`, no `max` |
| `sonnet` | `low`, `medium`, `high`, `max` | no `xhigh` |
| `opus` / `fable` | `low`, `medium`, `high`, `xhigh`, `max` | full scale |

## Approval

There is no Opus gate and no per-model approval in swarm: the manifest preview in the offer gate is the single confirmation artefact — the user sees every leaf, model, and effort before anything runs. If the user swaps a model in review, that's the decision; don't argue.

## Anti-patterns to refuse

- **Defaulting Haiku for analysis.** Haiku is for mechanical lookups; asking it to "be skeptical" or "synthesise" yields template-imitation, not analysis.
- **Reserving `:cloud` models for throwaway work.** They are sonnet/opus-lite-class on bounded leaves — casting them only for trivia forfeits the group-think breadth that is the product.
- **Claude tiers on every leaf out of habit.** Final synthesis and subtle judgement, yes; bounded closed-question leaves, no.
- **Pinning an unsupported effort on a Claude tier** — `validate` rejects it at load; fix the pairing, don't drop the effort silently.
- **Jumping tiers before trying effort.** Reach for `sonnet`+high before `opus`+low; raise a `:cloud` model's effort before promoting the leaf.
- **Per-leaf price deliberation.** Pick from the list using this page and move on — spend the favourable economics on redundant attempts and judge panels, not on choosing ceremony.
