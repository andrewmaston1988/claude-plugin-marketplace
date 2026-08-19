Write STATE.md in this exact shape. Sections are tagged [stable] (rarely change — leave verbatim on reconcile unless a fact moved) and [live] (re-check every checkpoint). Be aggressively concise; no historical narrative; only what's needed to resume. Substantial durable content (design rationale, investigation narrative, a decision with real nuance) is filed in the sibling `docs:` dir as `<free-form-name>.md` and referenced here as `path — one-line hook` (the KEY FILES idiom) — never inlined.

```
---
session: <one-line continuation description>
saved:   <date/time>
cwd:     <absolute path>   branch: <name> (clean|dirty)
resume:  <the single first action the next session should take>
docs:    <sibling docs dir path for substantial write-ups; omit if unused>
---

## OBJECTIVE              [stable]
One sentence: the goal of this work.

## CURRENT STATE          [live]
Done · in-progress · broken (with current understanding). Lengthy investigation narrative → file under `docs:` and link it here.

## NEXT ACTIONS           [live]
1. … (ordered; #1 == the `resume:` header line)

## CONSTRAINTS & DECISIONS [stable]
Hard must-nots + canonical [decision → reason]. No history. Long rationale behind a decision → file under `docs:` and link it here.

## ENV & COMMANDS         [stable]
Runtimes · build / test / run commands · key paths.

## KEY FILES              [live]
- path:line — why it matters. Signatures / schemas / invariants. No dumped files.

## OUT OF SCOPE           [stable]
Explicitly what we are NOT doing / deferred.
```
