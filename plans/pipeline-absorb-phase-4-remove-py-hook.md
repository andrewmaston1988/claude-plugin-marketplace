# Pipeline absorb claude.db — Phase 4: remove legacy Python UserPromptSubmit hook

*Branch:* `autonomous/pipeline-absorb-phase-4-remove-py-hook`

*Prerequisites:* `autonomous/pipeline-absorb-phase-3-readers`

*Title:* `pipeline: remove legacy Python UserPromptSubmit hook`

*Type:* `dev`

*Parent:* `pipeline-absorb-claude-db.md` (5-phase migration; this is phase 4 of 5)

---

## Problem / Goal

Retire the legacy Python `UserPromptSubmit` hook that registers `scripts/session_user_submit_hook.py` from the global Claude Code settings. After phase 2 the plugin's `UserPromptSubmit` hook (paths defined by phase 2 — see precondition 1.f) has been writing to `pipeline.db.claude_sessions` in parallel; after phase 3 every reader (`keepalive_check.py`, plus the phase-3-introduced reader in `plugins/pipeline/scripts/metrics/sessions.mjs` — exact function name owned by phase 3) reads from `pipeline.db`. Phase 4 cuts the Python hook out so the plugin is the **sole writer** of `claude_sessions` and the **sole source** of the keepalive-init template injection. After phase 4 lands and soaks 24 h, phase 5 can delete the Python code and archive `claude.db`.

This is the highest-risk phase of the migration. `settings.json` is the global hook configuration — a malformed edit fails every Claude Code session at startup, and is a **global outage**: every Claude Code instance on the machine (including any autonomous session and the operator's ability to invoke `/update-config` to fix it) hard-fails on launch. A well-formed edit combined with an undiscovered phase-2 regression silently stops `claude_sessions` rows from being written and starves the keepalive chain (elapsed math goes haywire because there is no `user_ts` to subtract from `now`).

Because the edit is to operator dotfiles in the CLAUDE repo (`C:/code/CLAUDE/settings.json`, with `~/.claude/settings.json` a symlink pointing at it — see "Cross-repo coordination" below), this plan is framed as a **tracking + checklist plan**. The autonomous PR in the marketplace repo contains only the plan file (with the verbatim JSON block to remove embedded in Cross-repo coordination). The actual `settings.json` edit and the preconditions monitoring are operator hand-applied steps the plan codifies.

## Approach

1. **Preconditions gate (operator-driven, BEFORE any edit).** Confirm every item below — these are blocking. Do not proceed if any fails:
   1. Phase 2 plugin hook has been in flight for **>= 7 days** with zero error rows in whatever structured log phase 2 emits (defined by phase 2's logging implementation; cross-reference `<state-dir>/logs/orchestrator.jsonl` per the pipeline plugin's CLAUDE.md as the existing canonical log).
   2. Dual-writer parity: row growth rate in `pipeline.db.claude_sessions` over the last 24 h is **>= 99%** of row growth in `claude.db.claude_sessions` over the same window (allowing 1% slop for the brief race at write boundaries).
   3. Fresh manual probe: open a Claude Code session in a **non-marketplace project** (e.g. `C:/code/nova-parser/`), submit a single prompt, and within 10 s confirm a new row in `pipeline.db.claude_sessions` matching that `session_id` + `cwd`. This proves the plugin-registered `UserPromptSubmit` hook fires machine-wide, not only inside repos where the marketplace lives.
   4. No checkpoint-plugin migration is mid-flight (would also be editing `settings.json` -> JSON merge conflict). Check `repos/*/plans/*.md` for in-flight rows whose title mentions `checkpoint-plugin` or `UserPromptSubmit`.
   4.2. **Removal-target disambiguation.** Inspect the current `UserPromptSubmit` array in `C:/code/CLAUDE/settings.json` — it must contain **exactly one** entry whose `command` ends with `session_user_submit_hook.py`. If more entries exist (e.g., checkpoint-plugin landed between phases 2 and 4 and added its own entry), the removal target is ambiguous; pause and reconcile with the checkpoint-plugin owner. If checkpoint-plugin has shipped since phase 2, also confirm phase 2 dropped its compact+ injection scope (per phase 2 Risk 5), in which case precondition 1.h (last_checkpoint_size) is moot for this run.
   5. The `pipeline@andrewmaston1988-claude-plugins` entry remains `true` in `enabledPlugins` in `C:/code/CLAUDE/settings.json` (currently line 81). If a plugin disable has happened, the plugin hook is dormant and removing the Python hook would orphan everything.
   6. **Per-project plugin-disable audit.** Run `find C:/code -name settings.local.json -path "*/.claude/*"` and inspect each match for `enabledPlugins` overrides that mention `pipeline`. The global CLAUDE.md universal preferences instructs deleting these on appearance, but they must be verified absent before phase 4 — a project-local disable means probes in some projects silently fail post-edit.
   7. **Phase-2 artifact paths exist.** Verify that phase 2's plugin-hook artifacts are actually present in the marketplace repo: confirm the path phase 2 chose for the plugin `UserPromptSubmit` hook descriptor (e.g., `plugins/pipeline/hooks/hooks.json` or wherever phase 2 placed it) and the corresponding script (e.g., `plugins/pipeline/scripts/hooks/user-prompt-submit.mjs`) both exist on master. If phase 2 used different paths, update the references in this plan before proceeding. If either is missing, phase 2 has not landed and phase 4 is blocked.
   8. **Schema column presence.** Run `sqlite3 ~/.pipeline/pipeline.db "PRAGMA table_info(claude_sessions);" | grep last_checkpoint_size` — must return a row. This was added by phase 2's SCHEMA_V8 (see phase 2 Approach step 1). If phase 2 closed without it, that is a phase-2 hotfix, not a phase-4 blocker per se — but if the column is absent AND checkpoint-plugin has NOT taken over the compact+ injection (precondition 1.d.2), the size-aware `/compact+` rate-limiter degrades after phase 4 because the sole writer cannot persist the size. Hotfix phase 2 (or confirm checkpoint-plugin coverage) before proceeding.
   9. **Phase-1 backfill correctness.** Run `sqlite3 ~/.pipeline/pipeline.db "SELECT MIN(started_at), COUNT(*) FROM claude_sessions;"` and confirm `MIN(started_at)` predates phase 2's merge date AND `COUNT(*)` matches `claude.db.claude_sessions` row count within 1%. Phase 2 Approach step 2 ran a corrective backfill (the phase-1 SQL referenced `started_at` against a column actually named `ts`); this precondition confirms that corrective backfill landed. If `MIN(started_at)` is later than phase 2's merge date, pre-phase-2 historical rows are missing — run the corrected backfill from phase 2 before phase 4 proceeds.
2. **Snapshot the current settings.json and embed the verbatim removal block in the plan.** Operator copies `C:/code/CLAUDE/settings.json` -> `C:/code/CLAUDE/settings.json.pre-phase4.bak` before any edit. **Additionally**, the verbatim JSON block being removed is reproduced in this plan's "Cross-repo coordination" section so it becomes part of the autonomous PR diff (recoverable from git history even if both the live file and `.bak` are subsequently lost). It is also mirrored into the merge commit message for redundancy.
3. **Edit `C:/code/CLAUDE/settings.json` via the `/update-config` skill, not raw text edit.** Remove **only the entry** whose `command` path ends with `session_user_submit_hook.py`; preserve any other entries in the `UserPromptSubmit` array. If the array is empty after removal, delete the `UserPromptSubmit` key entirely. All other hook arrays — `PreToolUse`, `PostToolUse`, `PreCompact`, `SessionStart`, `Stop` — must remain byte-identical. The verbatim JSON block to remove is reproduced in "Cross-repo coordination" below.
4. **Validate JSON in a separate file before saving.** Write the proposed new content to `C:/code/CLAUDE/settings.json.tmp`, run `python -m json.tool < C:/code/CLAUDE/settings.json.tmp` (or `node -e "JSON.parse(require('fs').readFileSync('C:/code/CLAUDE/settings.json.tmp','utf8'))"` with forward-slash path and no `String.raw`/backtick syntax) — must exit 0. Only if validation passes, rename `.tmp` over the live file. If validation fails, delete the `.tmp` and abort; the live `settings.json` is never touched in an invalid state. This guarantees that even if the validator misses something, the global outage cannot occur because the file the launcher reads was never written to.
5. **Restart trigger.** Settings reload at session start, so the Python hook keeps firing in already-running sessions until each is restarted. Operator closes every open Claude Code session within ~10 min of the edit to force reload. Sessions that stay open beyond that window create a temporary triple state (Python hook still writing to `claude.db`, plugin hook writing to `pipeline.db`, no reads from `claude.db` after phase 3) — harmless but worth noting.
6. **Post-edit verification (operator-driven, within 1 h).** Run the runtime checks in "Test plan" below. If **any** signal fails, immediately restore `settings.json.pre-phase4.bak` and pause the migration; investigate the regression in phase 2/3 before retrying.
7. **24 h soak.** Leave the system running for >= 24 h before queueing phase 5. Phase 5 (delete Python sources, archive `claude.db`) is destructive and irreversible without git history; phase 4 must demonstrate steady-state stability first.
8. **Mark the umbrella plan's phase 4 row complete** only after the 24 h soak passes and the merge commit lands. Move this plan to `plans/complete/` per plan-discipline DoD.

## Files Changed

**New:**
- `plans/pipeline-absorb-phase-4-remove-py-hook.md` — this plan file (the autonomous PR's primary artifact, including the verbatim JSON removal block in Cross-repo coordination).

**Modified (operator hand-applied, outside this repo — listed for tracking only):**
- `C:/code/CLAUDE/settings.json` — remove the entry in the `UserPromptSubmit` array whose `command` ends with `session_user_submit_hook.py`. `~/.claude/settings.json` is a symlink to this file (verified: `ls -la ~/.claude/settings.json` -> `-> /c/code/claude/settings.json`), so there is exactly **one** physical file to edit despite umbrella plan wording about "mirrors".
- `C:/code/CLAUDE/settings.json.pre-phase4.bak` — snapshot copy created before edit, kept until phase 5 closes. Not committed; lives in the dotfile repo's gitignored area.
- `C:/code/CLAUDE/settings.json.tmp` — transient validation target during Approach step 4; deleted on validation failure, renamed over the live file on success.

**Deleted:** none in this phase (phase 5 deletes `scripts/session_user_submit_hook.py`, `claude_db.py`, etc.).

(Note: no plugin-side log-line addition is made by this plan — phase 2 Approach step 8 already mandates per-invocation structured logging. The phase-4 verification checks rely on that existing log line.)

## Test plan

All checks are operator-driven (the autonomous session has no write access to `~/.claude/settings.json`). Run in order. **Any failure -> rollback step 6 of Approach.**

### Pre-edit baseline (capture for delta comparison)
1. `sqlite3 ~/.pipeline/pipeline.db "SELECT COUNT(*) FROM claude_sessions;"` — record as `N0_pipeline`.
2. `sqlite3 C:/code/CLAUDE/claude.db "SELECT COUNT(*) FROM claude_sessions;"` — record as `N0_legacy`.
3. `sqlite3 ~/.pipeline/pipeline.db "SELECT COUNT(*) FROM claude_sessions WHERE CAST(user_ts AS REAL) >= strftime('%s','now','-24 hours');"` -> `R24_pipeline`. Same query against `claude.db` -> `R24_legacy`. Assert `R24_pipeline / R24_legacy >= 0.99` (the precondition 1.b parity check). If this fails, **stop** — phase 2 has a silent drop bug. (The `CAST(user_ts AS REAL)` is necessary because `user_ts` is a TEXT column storing a stringified REAL per the actual schema; lexicographic ordering of TEXT timestamps is only correct while widths match.)
4. `python -m json.tool < C:/code/CLAUDE/settings.json > /dev/null` (or, if Python is unavailable, `node -e "JSON.parse(require('fs').readFileSync('C:/code/CLAUDE/settings.json','utf8'))"`) — must exit 0. Captures the file is currently valid before the edit.

### Post-edit verification (within 1 h of the settings.json edit)
1. **JSON well-formed:** repeat the `python -m json.tool` / `JSON.parse` command. Must exit 0. If non-zero, restore the backup immediately via OS shell `cp` (see Rollback procedure — do NOT rely on any claude/skill tooling because a malformed settings.json locks the CLI out).
2. **Hook block correct:** `python -c "import json; s=json.load(open('C:/code/CLAUDE/settings.json')); print(','.join(sorted(s['hooks'].keys())))"` — must print `PostToolUse,PreCompact,PreToolUse,SessionStart,Stop` (no `UserPromptSubmit`), assuming the array was empty after removal. If precondition 1.d.2 found other entries in `UserPromptSubmit`, `UserPromptSubmit` may still appear — and the printed value of `s['hooks']['UserPromptSubmit']` must contain no entry pointing at `session_user_submit_hook.py`.
3. **Fresh session writes one row with correct identity:** close all Claude Code windows, open one new session in `C:/code/nova-parser/`, submit the literal prompt `phase 4 probe`. Determine the probe `session_id` by reading `~/.claude/sessions/<pid>.json` for the new session's PID. Within 10 s:
   - `sqlite3 ~/.pipeline/pipeline.db "SELECT session_id, cwd, user_ts FROM claude_sessions ORDER BY CAST(user_ts AS REAL) DESC LIMIT 1;"` — must return a row whose `cwd` matches the exact normalised form the mjs port emits (forward slashes, drive letter case as defined by phase 2's normalisation — operator confirms once during phase 2 close-out and pins the literal expected string here at queue time; default expectation is `C:/code/nova-parser` with forward slashes and lower-case drive letter) AND whose `session_id` **matches the value in `~/.claude/sessions/<pid>.json`** (not just "a row exists"). A row with a different hex-uuid `session_id` indicates the matcher fell back to `uuid4()` — failure.
   - `sqlite3 C:/code/CLAUDE/claude.db "SELECT session_id, cwd, user_ts FROM claude_sessions ORDER BY CAST(user_ts AS REAL) DESC LIMIT 1;"` — must **not** have a new row from this probe (proves the Python hook is no longer firing). If a new `claude.db` row appears, the Python hook is still wired — re-check the edit.
4. **Keepalive chain alive (correct semantics — `user_ts` is PRESERVED on keepalive ticks, not advanced).** The Python behavior is that keepalive ticks call upsert with `user_ts=None`, preserving the original user submit time. Therefore:
   - Wait 5 min after the probe, then `sqlite3 ~/.pipeline/pipeline.db "SELECT ts, user_ts FROM claude_sessions WHERE session_id = '<probe-session-id>';"`. **`user_ts` must remain at the original probe value** (it does NOT advance on keepalive ticks). If `user_ts` advances during the 5-min wait with no operator prompt, the mjs port is mistakenly treating keepalive ticks as user prompts — failure.
   - Observe an explicit keepalive event: tail the phase-2-defined structured log (cross-reference `<state-dir>/logs/orchestrator.jsonl` per the plugin CLAUDE.md, or whatever path phase 2 chose) for the specific event name phase 2 emits for keepalive init injection (the event name is owned by phase 2 — pin the literal substring here at queue time). At least one such event must appear in the 5-min window. The probe session must be left open with focus during this window to allow the scheduler to fire.
   - Submit a second, **non-keepalive** prompt (e.g., literal `phase 4 keepalive probe`). Within 10 s, `user_ts` for the probe `session_id` must advance to the new submit time. If it does not, the upsert path for real user prompts is broken.
5. **No Python hook errors and the log dir actually exists:** first run `ls C:/code/CLAUDE/logs/ 2>/dev/null || ls ~/.pipeline/logs/ 2>/dev/null` to confirm at least one Python-hook log directory exists (the Python hook historically writes to either of these; confirm the actual path during precondition 1.a). Then `grep -iE "session_user_submit_hook|UserPromptSubmit" <log-dir>/*.log | wc -l` — the count must be `0` for any timestamp **after** the settings.json edit. (Counts from before the edit are expected and irrelevant.) Any reference to the Python hook firing after the edit is a failure mode. If the log directory does not exist at all, that is itself a finding — escalate before proceeding, because precondition 1.a's "zero error rows" claim was made against a path that doesn't exist.
6. **`/pipeline:pipeline` row classification still works:** open `pipeline dashboard tui` (or run `pipeline list --status active`). Active sessions must show with a non-null `cwd` column. If the phase-3 reader (function name and location owned by phase 3) returns zero IDs, the reader+writer aren't agreeing on schema — rollback.
7. **Multi-project probe (smoke):** repeat step 3's prompt-and-check in **two more projects** outside the marketplace: `C:/code/torrent-hub/` and `C:/code/hotpath/`. Each must produce exactly one new `pipeline.db.claude_sessions` row (with matching session_id from `~/.claude/sessions/<pid>.json`) and zero new `claude.db.claude_sessions` rows. Include at least one project the operator suspects may have had a project-local `.claude/settings.local.json` historically (per precondition 1.f). This re-verifies umbrella risk 2 (machine-wide firing) under the no-Python-fallback configuration.
8. **`enabledPlugins` re-check post-edit:** `python -c "import json; s=json.load(open('C:/code/CLAUDE/settings.json')); print(s.get('enabledPlugins',{}).get('pipeline@andrewmaston1988-claude-plugins'))"` — must print `True`. A stale `enabledPlugins` flip would silently disable the hook with no operator notification.
9. **`last_checkpoint_size` runtime probe:** if precondition 1.h confirmed the column exists (i.e., size-aware compact+ is still owned by this codepath, not by checkpoint-plugin), trigger a transcript >= 2 MB on the probe session and verify `sqlite3 ~/.pipeline/pipeline.db "SELECT last_checkpoint_size FROM claude_sessions WHERE session_id='<probe-session-id>';"` returns a non-null value matching the transcript size. If the value is null or the column is absent, the size-aware rate-limiter is degraded — rollback.

### 24 h soak (operator-driven; precondition for phase 5)
1. After 24 h, `sqlite3 ~/.pipeline/pipeline.db "SELECT COUNT(*) FROM claude_sessions WHERE CAST(user_ts AS REAL) >= strftime('%s','now','-24 hours');"` — must be **>= R24_legacy** captured pre-edit (proves the plugin sole-writer keeps pace).
2. `sqlite3 C:/code/CLAUDE/claude.db "SELECT COUNT(*) FROM claude_sessions WHERE CAST(user_ts AS REAL) >= strftime('%s','now','-24 hours');"` — must be `0`. Confirms the Python hook is fully retired.
3. No new structured-log lines matching `ERROR.*claude_session` (or whatever error shape phase 2 emits) over the 24 h window.
4. Governor cache health report (see governance-ops skill) shows non-zero interactive sessions classified — if it suddenly drops to zero, the classifier is mis-reading the new schema.
5. **Phase-5 pre-flight audit must pass (gate for queueing phase 5):** `rg -n "claude\.db|session_user_submit_hook\.py|claude_db\." across C:/code/CLAUDE/ and C:/code/claude-plugin-marketplace/` returns hits only in the phase-5 deletion target list (`scripts/session_user_submit_hook.py`, `scripts/claude_db.py`, `scripts/claude_db_migrations/`, `scripts/cache_metrics.py`, `scripts/migrate_metrics_to_db.py`, and the umbrella/phase plan files referencing the migration). Any live reference to `claude_db.append_claude_session`, `get_active_sessions`, or the `claude.db` file path outside that list — particularly in `keepalive_check.py` (mirrors phase 3 Risk 3) — blocks phase 5 queueing.

## Risks

**Risk 1 — Malformed JSON on save (global outage).** `settings.json` is the global hook config. A trailing comma, missing brace, or accidental BOM means every Claude Code launch on the machine fails immediately (`SyntaxError: Unexpected token ...`) — a **global outage** that includes any autonomous session in flight and the operator's ability to invoke `/update-config` to fix the very file that broke things. Mitigation: edit via `/update-config` skill (it owns JSON manipulation); validate by writing to `settings.json.tmp` first, running `python -m json.tool < .tmp` (Approach step 4) in a separate shell, and only renaming over the live file on success — the live `settings.json` is never touched while invalid. Keep `settings.json.pre-phase4.bak`. Signal: any new Claude Code session started post-edit immediately exits with `SyntaxError` — do not open more sessions; restore `.bak` via plain OS shell `cp`, do NOT rely on `/update-config`, `claude`, or any skill tooling because they may all be locked out.

**Risk 2 — Phase 2 regression masked by dual-writer.** While the Python hook still fires, any silent bug in the mjs port (missed `session_id`, wrong `cwd` normalisation, swallowed keepalive ticks) is invisible because the Python hook continues to populate `claude.db` — and phase 3 hasn't been pointed at it for those signals. After phase 4, the plugin is the only writer. Mitigation: the 7-day phase-2 soak (precondition 1.a) plus the 99% parity check (precondition 1.b) catch the most common drift. Signal: `pipeline.db.claude_sessions` row count plateaus after the edit while user activity continues; keepalive elapsed math in `keepalive_check.py` returns `RESCHEDULE:240` repeatedly (the exception-path fallback) instead of normal cadence.

**Risk 3 — Plugin-registered `UserPromptSubmit` doesn't fire machine-wide.** Plugin hooks are only known to fire when the plugin is **enabled** in `enabledPlugins` AND the session has access to the plugin's marketplace. The marketplace plugin entry in `C:/code/CLAUDE/settings.json` (line 81) means the hook is registered globally — but this is an assumption worth re-verifying for every fresh project before phase 4. Mitigation: precondition 1.c (non-marketplace project probe), precondition 1.f (per-project `settings.local.json` audit — a project-local `enabledPlugins:false` would silently disable the hook in only that project), and post-edit step 7 (two additional non-marketplace probes including one with historical settings.local.json risk). Signal: probe in `nova-parser` writes nothing to `pipeline.db.claude_sessions` — abort and re-investigate plugin discovery semantics.

**Risk 4 — Cache-keepalive chain dies silently.** The Python hook's keepalive-init template injection at >= 240 s gap is the heartbeat that schedules the next `Cache keepalive tick` prompt. The Python behavior is that **on keepalive ticks the upsert preserves `user_ts` (passes `None`)** — `user_ts` only advances on real user prompts. If the mjs port either forgot the keepalive-init branch entirely (no heartbeat at all) or accidentally advances `user_ts` on every keepalive tick (treating ticks as user prompts), the chain semantics are broken in subtly different ways. Mitigation: post-edit step 4 (a) confirms `user_ts` does NOT advance during the 5-min wait, (b) confirms a structured keepalive-event log line is emitted by phase 2's logger in that window, and (c) confirms a fresh non-keepalive prompt DOES advance `user_ts`. Signal: any of those three sub-checks fails; or governance-ops "cache health" trends downward without anomalous user activity.

**Risk 5 — Concurrent or already-landed checkpoint-plugin edit.** The checkpoint-plugin migration also writes to the `UserPromptSubmit` array. Two distinct failure modes: (a) if checkpoint-plugin is mid-flight when phase 4 fires, the two operator edits collide; (b) if checkpoint-plugin already landed and added a second entry to the `UserPromptSubmit` array, phase 4's removal target is ambiguous — a naive "delete the whole array" instruction would wipe out the checkpoint hook. Mitigation: precondition 1.d (in-flight check) AND precondition 1.d.2 (inspect array — must contain exactly one entry pointing at `session_user_submit_hook.py`, otherwise pause and reconcile with checkpoint-plugin owner); Approach step 3 explicitly removes only the matching entry, not the array key. Cross-reference: if checkpoint-plugin landed between phases 2 and 4, phase 2 Risk 5's scope reduction means the size-aware compact+ injection has migrated to checkpoint-plugin, and precondition 1.h (last_checkpoint_size) is moot for this run.

**Risk 6 — `last_checkpoint_size` column ownership.** Owned by phase 2 (SCHEMA_V8 in `connection.mjs`); if phase 2 closed without it, that is a phase-2 hotfix, not a phase-4 blocker. Phase 4 precondition 1.h verifies the column exists; if it does not AND checkpoint-plugin has not taken over compact+ (precondition 1.d.2 reconciliation), block on phase-2 hotfix. The runtime probe in post-edit step 9 confirms the writer actually persists the value on transcripts >= 2 MB.

**Risk 7 — Rollback window is sessions-restart-time, not seconds.** Even after restoring `settings.json.pre-phase4.bak`, every still-open Claude Code session is running with the no-`UserPromptSubmit` configuration cached at its start. Rollback only takes effect on the next session start. Mitigation: rollback procedure includes "close all Claude Code windows after restoring backup". Signal: post-rollback, `claude.db.claude_sessions` row count remains flat for an hour — operator forgot to restart sessions.

**Risk 8 — Phase-1 backfill correctness.** Phase 1's backfill SQL selected `started_at` from `claude.db` which only has a `ts` column. Phase 2 Approach step 2 explicitly re-ran the corrective backfill (`SELECT ts AS started_at`). If that corrective backfill silently failed or was skipped at phase-2 close-out, `pipeline.db.claude_sessions` contains only rows written by the phase-2 mjs hook since phase 2 landed — pre-phase-2 historical sessions are missing. The 99% parity precondition (1.b) only measures the last 24 h and masks this entirely. After phase 4, any reader needing historical session data (classifier reaching further back, governance reports) returns empty/short results. Mitigation: precondition 1.i — `sqlite3 pipeline.db "SELECT MIN(started_at), COUNT(*) FROM claude_sessions;"` confirms `MIN(started_at)` predates phase 2's merge date AND `COUNT` matches `claude.db` row count within 1%. Signal: `MIN(started_at)` in `pipeline.db` is later than phase-2 merge date.

**Risk 9 — Session-ID resolution drift between Python and mjs hook.** The Python hook scans `~/.claude/sessions/<pid>.json` and picks the highest `updatedAt`, falling back to `uuid4().hex` if no match. If the mjs port uses a different matcher (always-uuid fallback, different priority), rows in `pipeline.db` will have `session_id`s that do not correlate with what the classifier/keepalive expect. Under dual-writer, masked because most reads pre-phase-3 come from `claude.db` (Python-style IDs). Mitigation: post-edit step 3 explicitly asserts the probe row's `session_id` matches the value in `~/.claude/sessions/<pid>.json` (not just "a row exists"). Signal: probe row exists but `session_id` is a hex uuid not matching the sessions file — fallback path firing because matcher logic differs.

**Rollback procedure.** `cp C:/code/CLAUDE/settings.json.pre-phase4.bak C:/code/CLAUDE/settings.json` from a plain OS shell (do NOT rely on any claude/skill tooling — those may be locked out by Risk 1's failure mode), then close and reopen every Claude Code window. The exact JSON block being removed is reproduced verbatim in Cross-repo coordination below (and again in the merge commit message), so even if the `.bak` file is missing, the operator can hand-restore by pasting the block back at the right position. Because the block is captured in the autonomous PR diff, it is also recoverable from git history.

## Cross-repo coordination

This is the load-bearing point of this plan: **the substantive change lives entirely outside the marketplace repo, in operator dotfiles.** The autonomous session can edit only what is inside `C:/code/claude-plugin-marketplace/` (`plans/`, `plugins/pipeline/`). It **cannot** edit `C:/code/CLAUDE/settings.json` (no write access; raw edits there are blocked by the `/update-config` skill convention and by CLAUDE.md universal preferences).

### Verbatim JSON block to remove

The entry being removed from `C:/code/CLAUDE/settings.json` is the `UserPromptSubmit` hook entry whose `command` ends with `session_user_submit_hook.py`. The literal block (to be reproduced verbatim from the operator's pre-edit snapshot at queue time, and pinned here before the autonomous PR opens) follows the canonical shape:

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "<absolute path to session_user_submit_hook.py>"
      }
    ]
  }
]
```

If `precondition 1.d.2` finds additional entries (e.g., checkpoint-plugin added its own), the operator removes only the matching `hooks` entry (not the entire array) and pastes the exact removed object verbatim into the merge commit message for rollback parity. Pin the exact byte-level content here before opening the autonomous PR — do not leave this as a placeholder past queue time.

### Who does what

What the autonomous session does:
- Author this plan file at `plans/pipeline-absorb-phase-4-remove-py-hook.md`, with the verbatim JSON block above pinned by the operator at queue time.
- Open a PR with the plan. The PR description includes the literal JSON block to remove and the exact byte location.
- Mark the umbrella plan's phase 4 row complete **only after** the operator confirms the post-edit verification and 24 h soak pass.

What the operator hand-applies after PR review:
- All preconditions in Approach step 1 (including the schema-column and backfill checks).
- The settings.json snapshot in Approach step 2.
- The settings.json edit via `/update-config` skill in Approach step 3.
- The JSON validation in Approach step 4 (writing to `.tmp` first, validating in a separate shell, renaming only on success).
- The session restart in Approach step 5.
- All "Post-edit verification" and "24 h soak" items in Test plan.

The single-symlink correction matters: umbrella plan refers to "BOTH edits" in `~/.claude/settings.json` AND `C:/code/CLAUDE/settings.json`. Verified live with `ls -la`: `~/.claude/settings.json` is a symlink to `/c/code/claude/settings.json`, so there is exactly **one** physical file. The operator edits it once. Do not perform two edits — the second is a no-op at best and confusing at worst.

## Open Questions

(None remaining at authoring time. Items previously open are now hard preconditions:
- The keepalive-init template behaviour question is now Risk 4's three-part runtime check (post-edit step 4 sub-checks a/b/c).
- The `last_checkpoint_size` column question is now precondition 1.h plus runtime probe in post-edit step 9; column ownership rests with phase 2's SCHEMA_V8.
- The post-edit `enabledPlugins` re-check is now post-edit verification step 8.)

## Current Status

- [ ] Preconditions gate passed (all 9 items confirmed by operator)
- [ ] Snapshot `settings.json` -> `.pre-phase4.bak`
- [ ] JSON removal block pinned in Cross-repo coordination
- [ ] Plan file authored and committed
- [ ] Post-edit JSON validation passes
- [ ] Hook block contains no entry pointing at `session_user_submit_hook.py`
- [ ] Single-project probe writes to `pipeline.db.claude_sessions` and not to `claude.db.claude_sessions`
- [ ] Keepalive semantics verified: `user_ts` preserved during idle window, advances on user prompt
- [ ] Multi-project probes pass (3+ projects, zero Python-hook references in logs post-edit)
- [ ] `enabledPlugins` re-check confirms pipeline still enabled
- [ ] `last_checkpoint_size` column verified present and written
- [ ] 24 h soak period complete: plugin row count >= legacy baseline, zero new legacy rows
- [ ] Phase-5 pre-flight audit passes: no live references outside deletion target list
- [ ] Umbrella plan phase 4 row marked complete; this plan moved to `plans/complete/`

## Out of scope

- **Phase 5 (next):** archive `C:/code/CLAUDE/claude.db` to `~/.pipeline/archive/claude.db.archive-<date>`; delete `scripts/session_user_submit_hook.py`, `scripts/claude_db.py`, `scripts/claude_db_migrations/`, `scripts/cache_metrics.py`, `scripts/migrate_metrics_to_db.py`; strip `claude.db` references from `governance-ops` SKILL.md, `debug.md`, root `CLAUDE.md`, `codebase-index.md`. Fires only after the 24 h soak in this phase passes AND the `rg` pre-flight audit (24 h soak item 5) shows no live references outside the deletion target list.
- Schema patch to add `last_checkpoint_size` to `pipeline.db.claude_sessions` — owned by phase 2 (SCHEMA_V8 in `connection.mjs`); if phase 2 closed without it, that is a phase-2 hotfix surfaced by precondition 1.h, not new phase-4 work.
- Phase-1 backfill correction — owned by phase 2 Approach step 2; phase 4 precondition 1.i only verifies it landed.
- Repointing the Governor's session-classification thresholds — already covered in phase 3.
- Editing `~/.claude/settings.json` "and" `C:/code/CLAUDE/settings.json` as separate files — there is exactly one physical file (the former is a symlink to the latter); the umbrella plan's wording is corrected here in "Cross-repo coordination".
- Editing the umbrella plan (`plans/pipeline-absorb-claude-db.md`) to remove now-duplicated per-phase detail — this is a follow-up the operator must track outside this plan; left unedited, the umbrella becomes the rotten duplicate copy.
