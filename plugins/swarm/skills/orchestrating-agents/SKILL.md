---
name: orchestrating-agents
description: >-
  Use before dispatching any fan-out — authoring a manifest, or splitting a set of items
  across parallel agents. Decides how a plan splits into parallel agents, one per lane of
  disjoint files, merged only on shared reading surface, and sizes each by wall-clock and
  blast radius. Triggers — "fan this out", "how many leaves", "can we share more",
  "batch these items", "one agent per file". SKIP for: a single bounded task — there is
  nothing to group.
---

# Orchestrating Agents

## Overview

How a plan splits into parallel agents — decided by wall-clock, blast radius and shared
reading surface, not by how the plan happens to read.

The question is inverted from how it looks at first glance. It is not "how many agents, and
which items share one" — that is a compression question, and every answer to it merges. It
is "how does this plan split" — the default is one agent per lane from §2's partition of
disjoint files; a merge is the exception, and it needs a shared reading surface (§5) to
justify it.

**Core principle:** grouping is decided by wall-clock, blast radius and shared reading
surface — the three legs, on the page, before any agent is spawned. The recommendation is
wide at the default window — one agent per lane, merged only on shared surface; narrower is
the operator's override, and a bigger window is a wall-clock purchase.

*Measured once (2026-09-06, one plan, three shapes — the worked example below): under the
default window eight leaves and a four-link chain cost the same — what a leaf pays to start,
a chain pays back re-reading after compaction. Tokens do not decide grouping and nothing here
computes them.*

## The Iron Law

```
NO FAN-OUT WITHOUT WALL-CLOCK, BLAST AND SURFACE IN VISIBLE TEXT FIRST
```

**Violating the letter of this rule is violating the spirit of the rule.**

Eyeballed the leaf count? Noted the numbers in thinking? That is not the arithmetic. If the
three legs are not on the page (§2a), the decision was not made.

**No exceptions:**
- Not "the plan already decomposed it" — decomposition is how the work reads, not how it
  groups (§2 partitions it by files).
- Not "it's obviously N leaves" — obvious is exactly what the arithmetic is cheap enough to
  prove.
- Not "I'll note it in thinking" — thinking is not visible text.

**How aggressively to batch is the operator's call, not yours.** You present the numbers and a
recommendation; the operator picks the width. The floor — everything inline, zero
agents — is always one of the options. Under `swarm.always` (swarm skill → *Standing consent*)
the recommendation is taken: the arithmetic is computed and recorded in the manifest's shape,
not stated — this Iron Law keeps its force on the interactive path and stops applying where
nobody is reading the text.

## 2. Decompose before you group — divide and conquer is an instruction, not a hope

Planning is outside this plugin's surface: a plan arrives as a numbered list, and a numbered
list reads as a chain. Before the arithmetic block (§2a), this step is mandatory:

1. **Read the plan's file set** — its Files Changed table, or the files its steps name.
2. **Partition it into lanes by disjoint files.** A lane is a set of files no other lane
   touches.
3. **Order lanes only by real data dependencies** — a lane that reads what another lane
   produces — never by step number. The plan's numbering is narrative, not a dependency
   graph.
4. **Every lane with no such dependency is a parallel agent.**

A plan written as a chain is not a chain until its files say so. The block's `wall-clock:`
(longest dependency path) and `blast:` (largest lane) are read off this partition, not off
the plan's step count.

## 2a. The arithmetic — before the manifest

Write this block in visible text, filled in, before drafting anything:

```
wall-clock: longest path <k> serial items × 45m          = the run's long pole
blast:      largest single agent <b> items                = re-dispatched if it fails
axis:       merged on <shared reading surface | shared-file collision | model pin>
timeout:    per leaf, that leaf's items × 45m + headroom
```

Fill it from the lane partition, not the plan's step list: wall-clock is the longest
dependency path across lanes, blast the largest lane.

Three different objects, three different numbers: in a four-link chain whose links are
single items: wall-clock 4 × 45m, blast 1, timeout 45m + headroom per leaf; when the links
are whole phases (the worked example), blast is the largest phase's items and each leaf's
timeout is that phase's items × 45m + headroom. `blast:` counts the agent's items, not what
commit-as-you-go might salvage; dependents that stall are a wave question (§3), not blast.
The offer gate's question 1 already carries the token comparison for running this in-session,
as consent information — this block does not restate it.

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

- **Upward** — a cheaper item on a dearer agent — is legal only on shared surface (§5): the
  merged item runs its whole workload at the dearer rate, and that is what the `axis:` line
  justifies, not a shrug.
- **Downward** — a dearer item on a cheaper agent — is **never the session's call**. The pin
  came from a capability judgement; a batching decision that quietly relaxes it has changed
  what the operator approved. This is a prohibition, not a trade.
- **Effort is part of the pin.** Medium and max effort on one model share a model but not a
  cost, and a merged agent runs entirely at the higher one — same asymmetry, smaller
  magnitude. The standing rule is to escalate within a tier before jumping tiers, so effort
  boundaries are the ones you meet most often.
- **A consent-gated top-tier pin is merge-hostile for a second reason.** Where every such pin
  needs the operator's explicit yes, merging a cheaper item into it silently widens the scope
  of that yes. Consent for one item is not consent for its neighbours.

*Evidence: on one wave the leaf count came entirely from the pin column — two items with no dependency edge between them still needed their own leaf, forced apart by a pin their neighbours didn't share.*

## 5. Merge rule — shared reading surface is the precondition

A merge is legal only on shared reading surface: the coherence it buys and the duplicated
read it saves. Items without a shared reading surface split — a split costs nothing
measurable and buys parallel wall-clock and containment. A collision edge (§3) is exactly a
shared reading surface already found; once merged, it stops being a sequencing constraint.

## 6. Wall-clock, blast radius and coherence — the decision itself

The three bounds that decide grouping directly:

- **Wall-clock** — items inside an agent run serially; the deepest agent is the long pole.
- **Blast radius** — a failed agent costs every item inside it on re-dispatch.
- **Coherence** — one agent juggling many unrelated items degrades, and its own context
  fills.

**The timeout is wall-clock's hard edge; the other two are independent.** Wall-clock, blast
and coherence all degrade gracefully as an agent grows; the timeout does not — pushed past it,
a merge does not produce a slower agent, it produces a failed one with its last item
unstarted.

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
2. **Which later agent already reads its files?** Re-homing there is a merge with shared
   surface (§5) — legal, and it saves the duplicated read; the nearest wave has no such
   surface, so placing it there is a split — a new agent, not a merge.
3. **What does that do to the receiving agent's depth?** Re-homing spends its timeout budget;
   a third item on an already-deep agent is a merge decision, not a free move.

*Evidence:* an undelivered item's reflex home was the next wave, but re-homing it two waves later — into a leaf already reading both its files, with no consumer waiting until then — bought the duplicated read, turning a two-item collision into one serialised agent. Shared surface beat urgency.

## 8. Two corollaries

- **If this session must read the scope anyway to review and land it, the agent's read is
  duplicated, not saved** — the economic argument for in-session review.
- **Never transcribe a plan or spec into an agent prompt — point the agent at the file.**
  Transcription spends this session's output tokens to save the agent's input tokens, which is
  the wrong direction.

## 9. The gate question — four options, the floor always present

Present the numbers, lead with a recommendation, then let the operator choose. The
recommendation is wide at the default window — one agent per lane, merged only on shared
surface; narrower is the operator's override, and a bigger window is a wall-clock purchase.

| Option | What it costs |
|--------|--------------|
| **Zero-leaf** — fresh session, cheapest capable model, everything inline | no agents; quality risk, stated explicitly |
| **Deep** — merge past the surface precondition to the blast/wall-clock limit | the operator's call, never the recommendation; a failure costs many items; long serial pole |
| **Moderate** — merge shared-surface clusters, isolate the risky items | balanced blast radius and wall-clock |
| **Per-item** — one agent per item | maximum isolation and parallelism; smallest blast radius (one item each); most agents to supervise |

The two axes the question trades are **capability vs. risk** and **wall-clock vs. coherence**.
Name both, and always lead with a recommendation rather than a bare menu. Under `swarm.always`
the recommendation is taken: the three legs and the chosen point are computed and recorded in
the manifest's shape, not stated — the question is gone, not skipped.

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
| "The plan lists steps 1-7, so one leaf does 1-7" | The steps are narrative. Partition by files (§2); order only by real data dependencies. |
| "These steps depend on each other" | Only if a later one reads what an earlier one writes. A shared file is a collision (merge or sequence); a shared *topic* is nothing. |
| "The plan already decomposed it, so the leaf count is decided" | A plan's decomposition is how the work reads, not how it groups. Partition by files (§2) and run the arithmetic. |
| "These items read different subsystems, merging saves nothing anyway" | Wrong direction — merging unrelated items saves nothing measurable and costs the run its parallelism and containment. Shared surface is the precondition (§5), not a bonus. |
| "Batching risks a bigger blast radius, so keep them separate" | Not yours to pre-decide in either direction: the recommendation is one agent per lane, merged only on shared surface (§5); narrowing past that is the operator's Deep. |
| "I'll just note the numbers in thinking" | The arithmetic must be *visible text*. Numbers not on the page mean the decision was not made. |
| "These two can't run concurrently, so they need separate waves" | Only an *ordering* edge cuts a wave. A *collision* edge merges — they serialise in one agent and the constraint dissolves. |
| "The timeout is a manifest field, I'll set it when I write the JSON" | It is a row in the arithmetic, sized per-leaf from the depth just proposed, decided before the manifest. |
| "B obviously comes after A" | Name the header or the shared file, or it is not an edge. An invented edge costs a whole wave. |
| "Same wave, so they can share a leaf" | A leaf has one pin. The wave is cut again by tier before batching. |
| "It's only a small item, the cheap model will do" | Merging *down* is a capability decision, never a batching one. Never the session's call. |

## Red Flags - STOP

- "I'll eyeball the leaf count / note it in thinking" — the arithmetic is visible text.
- "The plan already decided the grouping" — the plan decomposed by steps; §2 decomposes by
  files, and that decides the grouping.
- "These share a topic, so they share a surface" — a topic is not a file. Merging without a
  named shared file or dependency is inventing an edge.
- "Different files, so separate waves" — collision edges merge; only ordering edges cut.
- "I'll set the timeout later in the JSON" — it is sized per-item at session start.
- "This item's small, run it on the cheaper agent" — that is merging down; refuse it.
- about to decide the leaf count yourself instead of presenting options to the operator.
- about to merge two items with no shared reading surface "to save a leaf" — a split costs
  nothing measurable; the merge does.

## Worked example — the water-light bake-off

```
water-light, 2026-09-06, one plan, byte-identical leaf prompts, three shapes:

  wide, default window:         8 leaves        cost 1.0×   ~5h    blast ≤ 4 items
  narrow chain, default window: 4-link chain     cost 1.0×   6h+    blast = a whole phase
                                                                     (23 compactions; one
                                                                     false STOP carried
                                                                     through every stage)
  same chain, 1M window:        4-link chain     cost 1.45×  ~4h    0 compactions

  counter-example: a 4-item agent on a flat 2h timeout (its 2-item sibling's value) hit the
  wall with one item unstarted. The 45-minute-per-item rule would have given it 3h.
```

Wide, at the default window, is the lean: width buys the clock and the containment for the
same tokens; the bigger window buys the clock alone, at 1.45×.
