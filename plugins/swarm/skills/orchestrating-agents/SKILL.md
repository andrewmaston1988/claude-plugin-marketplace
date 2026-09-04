---
name: orchestrating-agents
description: >-
  Use before dispatching any fan-out — authoring a manifest, or splitting a set of items
  across parallel agents. Decides how many agents and which items share one, by what each
  one costs to onboard. Triggers — "fan this out", "how many leaves", "can we share more",
  "batch these items", "one agent per file". SKIP for: a single bounded task — there is
  nothing to group.
---

# Orchestrating Agents

## Overview

How many agents a fan-out spawns, and which items share one — decided by what each agent
costs to onboard, not by how the plan happens to read.

A fan-out's dominant fixed cost is **onboarding**: the system prompt, every rule file, the
project instructions, and the tool schemas, re-paid at full rate by every agent with no
cache credit across them. **Every merge of two items into one agent saves one entire
onboarding.** Nothing else in the rule set decides grouping — model selection, engine
routing, and spend-consent each stop short of it — so it falls through unless this skill
forces it.

**Core principle:** every merge saves one whole onboarding, and the arithmetic proving where
that stops paying must be on the page before any agent is spawned.

**Violating the letter of this rule is violating the spirit of the rule.**

## The Iron Law

```
NO FAN-OUT WITHOUT THE ONBOARDING ARITHMETIC IN VISIBLE TEXT FIRST
```

Eyeballed the leaf count? Noted the numbers in thinking? That is not the arithmetic. If the
numbers are not on the page (§2), the decision was not made.

**No exceptions:**
- Not "the plan already decomposed it" — decomposition is how the work reads, not how it groups.
- Not "it's obviously N leaves" — obvious is exactly what the arithmetic is cheap enough to prove.
- Not "I'll note it in thinking" — thinking is not visible text.

**How aggressively to batch is the operator's call, not yours.** You present the numbers and a
recommendation; the operator picks the point on the curve. The floor — everything inline, zero
agents — is always one of the options. Under `swarm.always` (swarm skill → *Standing consent*)
the recommendation is taken: state the numbers and the chosen point, do not ask.

## 1. Instrument — read the onboarding cost, never estimate it

Run the shipped reader; resolve it as `<this skill's base directory>/scripts/onboarding-cost.mjs`:

```
node <base>/scripts/onboarding-cost.mjs
```

It self-locates this session's transcript and prints the onboarding figure — the first
assistant turn's `input_tokens + cache_creation_input_tokens`, which is exactly the prefix a
fresh agent re-pays — with the model, its context window, and the date read. State that
number **with its date** in the arithmetic block. It drifts upward as the rule set grows, and
the drift always biases toward *too many agents*.

If no transcript is readable the reader returns a dated `~40k` fallback flagged
`source: fallback`. **Surface that word out loud** — a floor to reason from, never a silent
default. This section documents the invocation; the arithmetic of the read lives in the
script, not here.

## 2. The mandatory arithmetic — before the manifest

Write this block in visible text, filled in, before drafting anything:

```
fan-out:   N agents × <onboarding>              = X
inline:    <scope you would read yourself>      = Y
batched:   M agents × <onboarding>              = Z     ← the proposal
zero-leaf: 1 × <onboarding>                     = W     ← the floor
axis:      merged on <shared reading surface | shared-file collision | model pin>
timeout:   deepest agent <k> items × 45m + headroom = T ← the hard bound
```

Every row earns its place: `inline` and `zero-leaf` are the two floors a proposal is judged
against; `axis` names *why* each merge is legal; `timeout` (below) turns the deepest agent's
depth from a feeling into a number.

## 3. Waves before batching — a different question, asked first

Batching asks *which items share one agent*. Waving asks *which items may run at the same
time at all*. Run the waving question **first**: it partitions the item set, and batching
then applies inside each partition. Merging across a dependency boundary is not a cheaper
agent, it is a wrong one.

1. **Draw the edges from files, not from topics.** Two items are dependent when one's output
   changes what the other reads — most often a shared file in both Files Changed tables. Read
   the file tables, not the titles.
2. **Admit an edge only if it is derivable** — from a plan header or a named shared file.
   Anything else ("B feels like it comes after A", "both about the graph") is an invented
   edge, and an invented edge costs a whole wave. **Re-run this whenever a shared-file
   constraint is added**: a new shared file creates real edges no header mentions yet, so a
   graph drawn once goes stale toward *missing* edges while derivability guards only against
   *extra* ones.
3. **Classify each edge.** *Ordering* (B needs A's result) → different waves. *Collision*
   (both rewrite the same region, either order works) → **merge into one agent**, where they
   serialise. *Independent* → free to share a wave and free to batch.
4. **Draw the graph; do not list the dependencies.** A list hides shape; a drawing shows
   whether the set is one long chain or several short chains converging — same edge count,
   completely different wave count. Six lines of ASCII, beside the arithmetic.
5. **Cut waves along the ordering edges only**, then partition each wave again by model pin
   (§4), then apply the batching arithmetic inside each partition. **The wave count is the
   longest chain, not the item count** — everything off that chain runs alongside it.
6. **Name what each wave hands the next.** That hand-off (`[SHARED_CONTEXT]`) is the
   session's judgement step, and is why the waves are separate manifests.

**Silent-loss edges outrank conflict edges.** The dangerous dependency is not the one that
produces a merge conflict — that announces itself. It is two items rewriting the same *logic*
in different places (a sort key, a composition rule), where both apply cleanly and the later
one silently owns the behaviour. When a plan says two items "must not land concurrently",
check which kind it is: a conflict edge can be a wave cut; a silent-loss edge should be a
merge.

*Evidence: a 14-item release's true critical path was five waves — but only after two wrong drafts, one inventing an edge no header asserted, the other missing one a later shared-file constraint created. Step 2 is a standing re-derivation for exactly that reason.*

## 4. Tier partitions inside a wave — a leaf carries one pin

The dependency graph says which items *may* run together; it says nothing about whether they
*can share an agent*, because an agent carries a single model and a single effort level. So a
wave is cut twice — by dependency, then by pin — and on a well-specified plan, where the
dependency graph is sparse and the tier column is not, the **pin cut usually sets the agent
count**.

**Which tier an item deserves is not this skill's question —
[the swarm tier guide](../swarm/references/model-selection.md) owns that judgement.** This section owns only what a pin *boundary* does to the agent count. Do not
restate the tier guide here.

Merging across a tier boundary is not free, and the two directions are not symmetrical:

- **Upward** — a cheaper item on a dearer agent — is arithmetic and *can pay*: you save one
  onboarding but run that item's whole workload at the higher rate, and the saved onboarding
  is itself priced higher. It pays when the item is small relative to onboarding and loses
  when it is large. That comparison is the `axis:` line's justification, not a shrug.
- **Downward** — a dearer item on a cheaper agent — is **never the session's call**. The pin
  came from a capability judgement; a batching decision that quietly relaxes it has changed
  what the operator approved. This is a prohibition, not a trade.
- **Effort is part of the pin.** Medium and max effort on one model share a model but not a
  cost, and a merged agent runs entirely at the higher one — same arithmetic, smaller
  magnitude. The standing rule is to escalate within a tier before jumping tiers, so effort
  boundaries are the ones you meet most often.
- **A consent-gated top-tier pin is merge-hostile for a second reason.** Where every such pin
  needs the operator's explicit yes, merging a cheaper item into it silently widens the scope
  of that yes. Consent for one item is not consent for its neighbours.

*Evidence: on one wave the leaf count came entirely from the pin column — two items with no dependency edge between them still needed their own leaf, forced apart by a pin their neighbours didn't share. The worked example at the end shows this merge cut.*

## 5. Merge rule + ordering heuristic

Every merge saves exactly one onboarding, **whether or not the merged items read the same
subsystem**. Shared reading surface is not what makes a merge pay — it is what makes a merge
pay *twice* (one onboarding **plus** one duplicated read) and what keeps the agent coherent.
So shared surface is an **ordering heuristic** for which merges to make first, never a
precondition for merging. And a collision edge, once merged, is not a sequencing constraint
any more — merging dissolves it.

## 6. The four bounds on merge depth

The only things that stop merging; none of them overlap:

- **Blast radius** — a failed agent costs every item inside it on re-dispatch.
- **Wall-clock** — items inside an agent run serially; the deepest agent is the long pole.
- **Coherence** — one agent juggling many unrelated items degrades, and its own context
  fills.
- **The timeout** — the **hard** bound. The other three degrade gracefully; this one
  truncates. A merge that pushes an agent's serial work past its timeout does not produce a
  slower agent, it produces a failed one with its last item unstarted.

**Sizing the timeout is part of the arithmetic, not a manifest afterthought.** Three rules
make deep batching survivable:

- **Per-leaf, so sized per-leaf.** The default is **45 minutes per collapsed item** —
  `items × 45m + headroom`. A flat value copied across a manifest is sized for the
  *shallowest* agent and silently under-sizes the deepest, which is the exact agent the merge
  rule pushed items into.
- **Decided at session start, from the item count, before the manifest is written.** The
  ceiling is an *input* to the batching decision, not a field filled in afterwards. Deciding
  it once the manifest exists means sizing it to a shape already chosen — which is how a flat
  value gets copied down a column.
- **Every agent prompt carries commit-as-you-go, verbatim:** *"Write files and commit as you
  go rather than holding everything to one long final turn."* This converts a timeout from
  total loss into partial delivery.

*Evidence:* a 4-item agent on a flat 2h timeout — the same value as its 2-item sibling — hit
the wall with one item unstarted. The 45-minute rule would have given it 3h. Commit-as-you-go
salvaged 3 of 4. The merge satisfied blast radius and coherence; the pre-timeout arithmetic
simply had no term for this.

## 7. Resequencing — re-home an undelivered item by shared surface, not urgency

A dropped or failed item is a free decision point: it has no wave yet, so place it where it
costs least rather than where it was. Ask, in order:

1. **Does anything downstream need it before its consumer's wave?** If not, it need not go in
   the next wave at all.
2. **Which later agent already reads its files?** Re-homing there buys a real shared reading
   surface — one onboarding *plus* one duplicated read — where the nearest wave buys only the
   onboarding.
3. **What does that do to the receiving agent's depth?** Re-homing spends its timeout budget;
   a third item on an already-deep agent is a merge decision, not a free move.

*Evidence:* an undelivered item's reflex home was the next wave, but re-homing it two waves later — into a leaf already reading both its files, with no consumer waiting until then — bought the duplicated read on top of the onboarding, turning a two-item collision into one serialised agent. Shared surface beat urgency.

## 8. Two corollaries

- **If this session must read the scope anyway to review and land it, the agent's read is
  duplicated, not saved** — the economic argument for in-session review.
- **Never transcribe a plan or spec into an agent prompt — point the agent at the file.**
  Transcription spends this session's output tokens to save the agent's input tokens, which is
  the wrong direction.

## 9. The gate question — four options, the floor always present

Present the numbers, lead with a recommendation, then let the operator choose:

| Option | Cost profile |
|--------|--------------|
| **Zero-leaf** — fresh session, cheapest capable model, everything inline | 1 × onboarding total; quality risk, stated explicitly |
| **Deep** — fewest agents blast radius allows | near-floor tokens; a failure costs many items; long serial pole |
| **Moderate** — merge shared-surface clusters, isolate the risky items | middle of the curve |
| **Per-item** — one agent per item | maximum isolation and parallelism; N × onboarding |

The two axes the question trades are **capability vs. risk** and **wall-clock vs. efficiency**.
Name both, and always lead with a recommendation rather than a bare menu. Under `swarm.always`
the recommendation is taken: state the numbers and the chosen point, do not ask.

## 10. Where this fires

Any fan-out, whatever dispatches it — the moment you are about to split a set of items across
parallel agents. In this plugin it is the offer gate's batching question; wherever else a
consuming instruction points here, the same arithmetic runs first.

## 11. Rejected: a hook — recorded so it is not "fixed" later

A pre-dispatch hook sees one call at a time, so it cannot distinguish a lone agent from the
first of five parallel ones. Every mechanical variant is worse: gate only the scripted path
and ad-hoc parallel dispatches leak; gate every single-agent dispatch and it fires constantly
on ordinary work; gate on "already dispatched this turn" and the first one is silently
permitted. The description-and-rule route dissolves the problem instead, because the session
knows its own intent before the call — and the expensive path is already guarded. Do not
replace this with a hook.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "The plan already decomposed it, so the leaf count is decided" | A plan's decomposition is how the work reads, not how it should be grouped. Run the arithmetic. |
| "These items read different subsystems, merging saves nothing" | Wrong — every merge saves one onboarding regardless. Shared surface makes it pay *twice*, it is not the precondition. |
| "Batching risks a bigger blast radius, so keep them separate" | That trade is the operator's, presented at the gate — not yours to pre-decide by staying wide. |
| "I'll just note the numbers in thinking" | The arithmetic must be *visible text*. Numbers not on the page mean the decision was not made. |
| "These two can't run concurrently, so they need separate waves" | Only an *ordering* edge cuts a wave. A *collision* edge merges — they serialise in one agent and the constraint dissolves. |
| "The timeout is a manifest field, I'll set it when I write the JSON" | It is a row in the arithmetic, sized per-leaf from the depth just proposed, decided before the manifest. |
| "B obviously comes after A" | Name the header or the shared file, or it is not an edge. An invented edge costs a whole wave. |
| "Same wave, so they can share a leaf" | A leaf has one pin. The wave is cut again by tier before batching. |
| "It's only a small item, the cheap model will do" | Merging *down* is a capability decision, never a batching one. Never the session's call. |

## Red Flags - STOP

- "I'll eyeball the leaf count / note it in thinking" — the arithmetic is visible text.
- "The plan already decided the grouping" — the plan decomposed; grouping is this decision.
- "They read different subsystems so merging is pointless" — every merge saves an onboarding.
- "Different files, so separate waves" — collision edges merge; only ordering edges cut.
- "I'll set the timeout later in the JSON" — it is sized per-item at session start.
- "This item's small, run it on the cheaper agent" — that is merging down; refuse it.
- about to decide the leaf count yourself instead of presenting options to the operator.

## Worked example — the real regroup

```
scout 0.9.6 wave 1, 2026-07-25:
  drafted straight from the roadmap:  6 × ~40k = ~1.02M
  regrouped, same 8 items, no scope removed, no model downgraded:
                                      3 × ~40k = ~526.6k   (49% reduction)
  the three merges: {1,2,5,6} Sonnet·medium/high · {7,8} on shared surface (max effort)
                    · {4,12} Haiku·high — the Haiku leaf forced by the pin, not the graph.
  what stopped further merging: leaf coherence and the tier boundary.
  counter-example: a 4-item leaf then took a FLAT 2h timeout (its 2-item sibling's value)
                   and truncated at 3 of 4 — every other bound satisfied. The 45m-per-item
                   rule would have given it 3h.
```

The six was never challenged by any rule; it was challenged by the operator noticing. Making
that arithmetic compulsory is the whole point of this skill.
