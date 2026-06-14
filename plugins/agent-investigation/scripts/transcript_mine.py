#!/usr/bin/env python3
"""
transcript_mine — mechanical mining of Claude Code session JSONLs.

Purpose: compress a long agent transcript into a compact report that captures
tool-call patterns, retries, errors, scope violations, and pivots — so a
reviewer (Claude or human) can distill the agent's method into a reusable
skill without reading the raw transcript.

All operations are pure Python stdlib. No LLM calls. No deps.

Subcommands
-----------
  sessions  <project_dir>                  list session JSONLs with rollup stats
  tools     <jsonl> [--top N]              tool-name frequency table
  ngrams    <jsonl> [--n 3] [--top 20]     tool-name N-gram patterns
  retries   <jsonl> [--window 5]           tool calls retried with similar input
  errors    <jsonl>                        all is_error=True tool results
  scope     <jsonl> --worktree <path>      file paths touched; flag out-of-scope
  findings  <a.jsonl> <b.jsonl>            contrastive overlap analysis (A vs B)
  pivots    <jsonl> [--min-text-chars N]   long-text moments (likely planning)
  slice     <jsonl> --turn N [--ctx M]     extract one turn ± context
  summary   <jsonl>                        single-page rollup (the default usage)
  agents    <jsonl>                        Agent tool dispatches (subagent runs)
  skills    <jsonl>                        Skill tool invocations + preceding text
  phases    <jsonl> [--text-threshold N]   auto-segment into work phases
  compare   <a.jsonl> <b.jsonl>            trajectory-level diff of two transcripts
  patterns  <jsonl> [--out FILE]           JSON candidate skill-rule shapes
  sample    <jsonl> [--n 20]               N representative turns for spot-check

Schema (Claude Code session JSONL — one event per line)
-------------------------------------------------------
  type=assistant  message.content is a list; tool_use blocks have
                  {type:'tool_use', name, id, input, caller?}
  type=user       message.content is a list; tool_result blocks have
                  {type:'tool_result', tool_use_id, content, is_error}
  type=last-prompt / mode / permission-mode / attachment / system / ai-title /
       file-history-snapshot / queue-operation — metadata, mostly ignored.

Out-of-scope by design: anything requiring LLM judgment. This tool is the
mechanical pre-pass; the judgment pass happens after, on the compact report.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Windows cp1252 stdout can't encode ≥, →, etc. Force UTF-8 once at import time.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, OSError):
    pass


# ---------------------------------------------------------------------------
# Event iteration
# ---------------------------------------------------------------------------

def iter_events(path: Path):
    """Yield (line_idx, event_dict) for each JSONL line. Skip parse errors."""
    with path.open(encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                yield i, json.loads(line)
            except json.JSONDecodeError:
                continue


def iter_tool_uses(path: Path):
    """Yield (line_idx, tool_use_block) — assistant tool_use blocks only."""
    for i, ev in iter_events(path):
        if ev.get("type") != "assistant":
            continue
        msg = ev.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                yield i, block


def iter_tool_results(path: Path):
    """Yield (line_idx, tool_result_block) — user tool_result blocks only."""
    for i, ev in iter_events(path):
        if ev.get("type") != "user":
            continue
        msg = ev.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                yield i, block


def iter_assistant_text(path: Path):
    """Yield (line_idx, text_str) for assistant text blocks (no tool calls)."""
    for i, ev in iter_events(path):
        if ev.get("type") != "assistant":
            continue
        msg = ev.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                txt = block.get("text") or ""
                if txt.strip():
                    yield i, txt


def iter_user_text(path: Path):
    """Yield (line_idx, text_str) for human-authored user text (not tool_result)."""
    for i, ev in iter_events(path):
        if ev.get("type") != "user":
            continue
        msg = ev.get("message") or {}
        content = msg.get("content")
        if isinstance(content, str) and content.strip():
            yield i, content
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    txt = block.get("text") or ""
                    if txt.strip():
                        yield i, txt


# ---------------------------------------------------------------------------
# Subcommand: sessions
# ---------------------------------------------------------------------------

def cmd_sessions(args):
    proj = Path(args.project_dir)
    jsonls = sorted(proj.glob("*.jsonl"))
    if not jsonls:
        print(f"(no .jsonl sessions in {proj})")
        return
    rows = []
    for p in jsonls:
        tool_uses = 0
        events = 0
        errors = 0
        first_ts = last_ts = None
        tool_counter = Counter()
        for _, ev in iter_events(p):
            events += 1
            ts = ev.get("timestamp") or (ev.get("message") or {}).get("timestamp")
            if ts:
                first_ts = first_ts or ts
                last_ts = ts
        for _, b in iter_tool_uses(p):
            tool_uses += 1
            tool_counter[b.get("name") or "?"] += 1
        for _, b in iter_tool_results(p):
            if b.get("is_error"):
                errors += 1
        top = ",".join(f"{n}({c})" for n, c in tool_counter.most_common(3))
        rows.append({
            "session": p.stem,
            "size_kb": p.stat().st_size // 1024,
            "events": events,
            "tool_uses": tool_uses,
            "errors": errors,
            "top": top,
        })
    print(f"{'session':38s} {'size_kb':>8s} {'events':>7s} {'tools':>6s} {'err':>4s}  top")
    for r in rows:
        print(f"{r['session']:38s} {r['size_kb']:>8d} {r['events']:>7d} {r['tool_uses']:>6d} {r['errors']:>4d}  {r['top']}")


# ---------------------------------------------------------------------------
# Subcommand: tools
# ---------------------------------------------------------------------------

def cmd_tools(args):
    path = Path(args.jsonl)
    counter = Counter()
    by_caller = defaultdict(Counter)
    for _, b in iter_tool_uses(path):
        name = b.get("name") or "?"
        raw_caller = b.get("caller")
        if isinstance(raw_caller, dict):
            caller = raw_caller.get("type") or raw_caller.get("name") or "?"
        else:
            caller = raw_caller or "main"
        counter[name] += 1
        by_caller[caller][name] += 1
    total = sum(counter.values())
    print(f"{'tool':32s} {'count':>6s}  {'pct':>5s}")
    for name, c in counter.most_common(args.top):
        print(f"{name:32s} {c:>6d}  {100*c/total:>4.1f}%")
    if len(by_caller) > 1:
        print("---by caller---")
        for caller, ctr in by_caller.items():
            top = ",".join(f"{n}({c})" for n, c in ctr.most_common(5))
            print(f"  {caller}: {sum(ctr.values())} calls — {top}")


# ---------------------------------------------------------------------------
# Subcommand: ngrams
# ---------------------------------------------------------------------------

def cmd_ngrams(args):
    path = Path(args.jsonl)
    seq = [b.get("name") or "?" for _, b in iter_tool_uses(path)]
    n = args.n
    if len(seq) < n:
        print(f"(too few tool calls for n={n})")
        return
    grams = Counter(tuple(seq[i:i + n]) for i in range(len(seq) - n + 1))
    print(f"# top {args.top} {n}-grams over {len(seq)} tool calls")
    for gram, c in grams.most_common(args.top):
        print(f"  {c:>4d}  {' → '.join(gram)}")


# ---------------------------------------------------------------------------
# Subcommand: retries
# ---------------------------------------------------------------------------

def cmd_retries(args):
    """Flag tool calls that look like retries: same tool within a sliding window,
    where the input dict overlaps materially (≥50% of keys+stringified-values match)."""
    path = Path(args.jsonl)
    uses = list(iter_tool_uses(path))
    win = args.window
    hits = []
    for i in range(len(uses)):
        line_i, bi = uses[i]
        name_i = bi.get("name")
        input_i = bi.get("input") or {}
        for j in range(i + 1, min(len(uses), i + 1 + win)):
            line_j, bj = uses[j]
            if bj.get("name") != name_i:
                continue
            input_j = bj.get("input") or {}
            sim = _input_similarity(input_i, input_j)
            if sim >= 0.5:
                hits.append((line_i, line_j, name_i, sim, _input_brief(input_i), _input_brief(input_j)))
    print(f"# {len(hits)} suspected retries (same tool within {win} calls, ≥50% input overlap)")
    for line_i, line_j, name, sim, a, b in hits[:50]:
        print(f"  L{line_i}→L{line_j} {name} sim={sim:.0%}")
        print(f"    a: {a}")
        print(f"    b: {b}")


def _input_similarity(a: dict, b: dict) -> float:
    keys = set(a) | set(b)
    if not keys:
        return 0.0
    matches = sum(1 for k in keys if str(a.get(k))[:200] == str(b.get(k))[:200])
    return matches / len(keys)


def _input_brief(d: dict) -> str:
    """One-line summary of a tool input dict."""
    if not d:
        return "(empty)"
    parts = []
    for k, v in d.items():
        s = str(v).replace("\n", " ")
        if len(s) > 60:
            s = s[:57] + "..."
        parts.append(f"{k}={s}")
        if sum(len(p) for p in parts) > 180:
            break
    return ", ".join(parts)


# ---------------------------------------------------------------------------
# Subcommand: errors
# ---------------------------------------------------------------------------

def cmd_errors(args):
    """List tool_result blocks where is_error=True, paired with the originating tool_use."""
    path = Path(args.jsonl)
    # Build map: tool_use_id → (line, name, input)
    use_index = {}
    for line, b in iter_tool_uses(path):
        use_index[b.get("id")] = (line, b.get("name"), b.get("input") or {})
    errs = []
    for line, b in iter_tool_results(path):
        if not b.get("is_error"):
            continue
        uid = b.get("tool_use_id")
        use_line, name, inp = use_index.get(uid, (None, "?", {}))
        content = b.get("content")
        if isinstance(content, list):
            content = " | ".join(
                (c.get("text") or "") if isinstance(c, dict) else str(c)
                for c in content
            )
        content = str(content or "").replace("\n", " ")
        if len(content) > 240:
            content = content[:237] + "..."
        errs.append((use_line, line, name, _input_brief(inp), content))
    print(f"# {len(errs)} errored tool calls")
    for use_line, res_line, name, inp, msg in errs:
        print(f"  L{use_line}→L{res_line} {name}({inp})")
        print(f"    !! {msg}")


# ---------------------------------------------------------------------------
# Subcommand: scope
# ---------------------------------------------------------------------------

# Tools that name a file in their input
_FILE_TOOLS = {
    "Read": "file_path",
    "Edit": "file_path",
    "Write": "file_path",
    "NotebookEdit": "notebook_path",
    "Glob": "path",
    "Grep": "path",
}

_BASH_PATH_RE = re.compile(r"(?:[A-Za-z]:[\\/]|/[a-z]/|\./|\.\./|/)[\w./\\\-]+")


def _normalize_path(p: str) -> str:
    if not p:
        return p
    p = p.replace("\\", "/")
    # Git Bash / WSL → Windows: /c/foo → c:/foo
    m = re.match(r"^/([a-zA-Z])/(.*)$", p)
    if m:
        p = f"{m.group(1).lower()}:/{m.group(2)}"
    return p.lower().rstrip("/")


def cmd_scope(args):
    path = Path(args.jsonl)
    worktree = _normalize_path(args.worktree) if args.worktree else None
    touched = Counter()
    out_of_scope = []
    for line, b in iter_tool_uses(path):
        name = b.get("name")
        inp = b.get("input") or {}
        candidate_paths = []
        if name in _FILE_TOOLS:
            p = inp.get(_FILE_TOOLS[name])
            if p:
                candidate_paths.append(p)
        elif name == "Bash":
            cmd = str(inp.get("command") or "")
            candidate_paths.extend(_BASH_PATH_RE.findall(cmd)[:5])
        for p in candidate_paths:
            np = _normalize_path(p)
            touched[np] += 1
            if worktree and not (np.startswith(worktree + "/") or np == worktree):
                # Allow read-only access to the target codebase — caller must specify
                if args.allow and any(np.startswith(_normalize_path(a)) for a in args.allow):
                    continue
                out_of_scope.append((line, name, np))
    print(f"# {len(touched)} distinct paths touched ({sum(touched.values())} ops)")
    print("# top 20 paths:")
    for p, c in touched.most_common(20):
        flag = "⚠" if worktree and not (p.startswith(worktree + "/") or p == worktree) else " "
        print(f"  {flag} {c:>4d}  {p}")
    if worktree:
        print(f"# {len(out_of_scope)} out-of-scope ops (worktree={worktree})")
        for line, name, p in out_of_scope[:30]:
            print(f"  L{line} {name} {p}")


# ---------------------------------------------------------------------------
# Subcommand: findings (contrastive analysis A vs B)
# ---------------------------------------------------------------------------

def _load_findings(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def cmd_findings(args):
    a = _load_findings(Path(args.a))
    b = _load_findings(Path(args.b))
    print(f"# A: {len(a)} findings   B: {len(b)} findings")

    # Severity breakdown
    sev_a = Counter(r.get("severity") for r in a)
    sev_b = Counter(r.get("severity") for r in b)
    print("# severity:")
    print(f"  A: {dict(sev_a)}")
    print(f"  B: {dict(sev_b)}")

    # Key = (file normalized, signal). Don't include line ranges — agents may disagree on bounds.
    def key(r):
        return (_normalize_path(r.get("file", "")), r.get("signal", ""))

    keys_a = {key(r): r for r in a}
    keys_b = {key(r): r for r in b}

    both = sorted(set(keys_a) & set(keys_b))
    only_a = sorted(set(keys_a) - set(keys_b))
    only_b = sorted(set(keys_b) - set(keys_a))

    print(f"# overlap: both={len(both)}  A-only={len(only_a)}  B-only={len(only_b)}")
    print("# HIGH-CONFIDENCE (both agents flagged same file+signal):")
    for k in both:
        ra, rb = keys_a[k], keys_b[k]
        sa, sb = ra.get("severity"), rb.get("severity")
        agree = "=" if sa == sb else "≠"
        print(f"  {agree} [{sa}/{sb}] {k[0]} :: {k[1]}")
        print(f"    A: {(ra.get('summary') or '')[:120]}")
        print(f"    B: {(rb.get('summary') or '')[:120]}")

    print("# A-ONLY (A's unique signals):")
    for k in only_a[:20]:
        r = keys_a[k]
        print(f"  [{r.get('severity')}] {k[0]} :: {k[1]} — {(r.get('summary') or '')[:90]}")

    print("# B-ONLY (B's unique signals):")
    for k in only_b[:20]:
        r = keys_b[k]
        print(f"  [{r.get('severity')}] {k[0]} :: {k[1]} — {(r.get('summary') or '')[:90]}")

    # Same file flagged with different signal types — disagreement on root cause
    files_a_sigs = defaultdict(set)
    for r in a:
        files_a_sigs[_normalize_path(r.get("file", ""))].add(r.get("signal"))
    files_b_sigs = defaultdict(set)
    for r in b:
        files_b_sigs[_normalize_path(r.get("file", ""))].add(r.get("signal"))
    diverge = []
    for f in set(files_a_sigs) & set(files_b_sigs):
        if not (files_a_sigs[f] & files_b_sigs[f]):
            diverge.append((f, files_a_sigs[f], files_b_sigs[f]))
    if diverge:
        print(f"# DISAGREEMENT ON ROOT CAUSE (same file, no shared signal type): {len(diverge)}")
        for f, sa, sb in diverge[:15]:
            print(f"  {f}: A={sorted(sa)}  B={sorted(sb)}")


# ---------------------------------------------------------------------------
# Subcommand: pivots
# ---------------------------------------------------------------------------

def cmd_pivots(args):
    """Surface long assistant text blocks — usually planning, reflection, or
    course-changes. These are the high-information moments for skill distillation."""
    path = Path(args.jsonl)
    threshold = args.min_text_chars
    hits = []
    for line, txt in iter_assistant_text(path):
        if len(txt) >= threshold:
            first = txt.strip().splitlines()[0][:140] if txt.strip() else ""
            hits.append((line, len(txt), first))
    print(f"# {len(hits)} long assistant text blocks (≥{threshold} chars)")
    for line, n, first in hits[:40]:
        print(f"  L{line:>6d}  {n:>5d}ch  {first}")


# ---------------------------------------------------------------------------
# Subcommand: slice
# ---------------------------------------------------------------------------

def cmd_slice(args):
    path = Path(args.jsonl)
    target = args.turn
    ctx = args.ctx
    events = list(iter_events(path))
    lo = max(0, target - ctx)
    hi = min(len(events), target + ctx + 1)
    for line_idx, ev in events[lo:hi]:
        t = ev.get("type")
        msg = ev.get("message") or {}
        content = msg.get("content")
        marker = ">>>" if line_idx == target else "   "
        if isinstance(content, str):
            print(f"{marker} L{line_idx} {t}: {content[:300]}")
        elif isinstance(content, list):
            parts = []
            for c in content:
                if not isinstance(c, dict):
                    continue
                ct = c.get("type")
                if ct == "text":
                    parts.append(f"[text] {(c.get('text') or '')[:150]}")
                elif ct == "tool_use":
                    parts.append(f"[tool_use] {c.get('name')}({_input_brief(c.get('input') or {})})")
                elif ct == "tool_result":
                    cc = c.get("content")
                    if isinstance(cc, list):
                        cc = " ".join(
                            (b.get("text") or "") if isinstance(b, dict) else str(b)
                            for b in cc
                        )
                    err = "!" if c.get("is_error") else " "
                    print_text = str(cc or "")[:150].replace("\n", " ")
                    parts.append(f"[tool_result{err}] {print_text}")
            print(f"{marker} L{line_idx} {t}: " + " | ".join(parts))
        else:
            print(f"{marker} L{line_idx} {t}")


# ---------------------------------------------------------------------------
# Subcommand: summary  (the headline)
# ---------------------------------------------------------------------------

def cmd_summary(args):
    """Single-page rollup. The intended primary entry point."""
    path = Path(args.jsonl)
    size_kb = path.stat().st_size // 1024

    events = 0
    tool_uses = []
    errs = 0
    err_examples = []
    long_texts = 0
    user_msgs = 0

    for _, ev in iter_events(path):
        events += 1

    for line, b in iter_tool_uses(path):
        tool_uses.append((line, b.get("name") or "?", b.get("input") or {}, b.get("id")))

    use_by_id = {tid: (line, name, inp) for line, name, inp, tid in tool_uses}
    for line, b in iter_tool_results(path):
        if b.get("is_error"):
            errs += 1
            if len(err_examples) < 5:
                uid = b.get("tool_use_id")
                ul, name, inp = use_by_id.get(uid, (None, "?", {}))
                content = b.get("content")
                if isinstance(content, list):
                    content = " | ".join(
                        (c.get("text") or "") if isinstance(c, dict) else str(c)
                        for c in content
                    )
                err_examples.append((ul, name, _input_brief(inp), str(content or "")[:200].replace("\n", " ")))

    for line, txt in iter_assistant_text(path):
        if len(txt) >= 600:
            long_texts += 1

    for _ in iter_user_text(path):
        user_msgs += 1

    tool_counter = Counter(n for _, n, _, _ in tool_uses)

    # Retries
    retries = 0
    for i in range(len(tool_uses)):
        line_i, name_i, inp_i, _ = tool_uses[i]
        for j in range(i + 1, min(len(tool_uses), i + 6)):
            line_j, name_j, inp_j, _ = tool_uses[j]
            if name_j == name_i and _input_similarity(inp_i, inp_j) >= 0.5:
                retries += 1
                break

    # N-gram top 5
    seq = [n for _, n, _, _ in tool_uses]
    trigrams = Counter(tuple(seq[i:i + 3]) for i in range(len(seq) - 2))

    print(f"# transcript_mine summary :: {path.name}")
    print(f"  size: {size_kb} KB   events: {events}   tool_uses: {len(tool_uses)}")
    print(f"  user_messages: {user_msgs}   long_assistant_texts (≥600ch): {long_texts}")
    print(f"  errored tool calls: {errs}   suspected retries: {retries}")
    print(f"  tools used: {len(tool_counter)} distinct")
    print(f"# top 8 tools")
    for n, c in tool_counter.most_common(8):
        print(f"  {c:>5d}  {n}")
    if trigrams:
        print(f"# top 5 tool trigrams")
        for g, c in trigrams.most_common(5):
            print(f"  {c:>5d}  {' → '.join(g)}")
    if err_examples:
        print(f"# first 5 errors")
        for ul, name, inp, msg in err_examples:
            print(f"  L{ul} {name}({inp})")
            print(f"    !! {msg}")


# ---------------------------------------------------------------------------
# Subcommand: agents — Agent tool dispatches (subagent runs)
# ---------------------------------------------------------------------------

def cmd_agents(args):
    """List every Agent tool dispatch with subagent_type, prompt length, and
    result length. Subagents are where the main loop offloads work; what they
    were dispatched for is high-signal for skill distillation."""
    path = Path(args.jsonl)
    use_index = {}
    for line, b in iter_tool_uses(path):
        if b.get("name") == "Agent":
            use_index[b.get("id")] = (line, b.get("input") or {})
    if not use_index:
        print("# no Agent tool dispatches in this session")
        return
    results = {}
    for line, b in iter_tool_results(path):
        uid = b.get("tool_use_id")
        if uid in use_index:
            content = b.get("content")
            if isinstance(content, list):
                content = " ".join(
                    (c.get("text") or "") if isinstance(c, dict) else str(c)
                    for c in content
                )
            results[uid] = (line, str(content or ""))
    print(f"# {len(use_index)} Agent dispatches")
    for uid, (line, inp) in use_index.items():
        subagent = inp.get("subagent_type") or "(general)"
        desc = (inp.get("description") or "")[:60]
        prompt = (inp.get("prompt") or "").replace("\n", " ")
        res_line, res = results.get(uid, (None, ""))
        print(f"  L{line} [{subagent}] {desc}")
        print(f"    prompt ({len(prompt)}ch): {prompt[:180]}")
        if res:
            print(f"    result L{res_line} ({len(res)}ch): {res[:180]}")


# ---------------------------------------------------------------------------
# Subcommand: skills — Skill tool invocations (skill reaches)
# ---------------------------------------------------------------------------

def cmd_skills(args):
    """Every Skill tool call with name, sequence position, and the assistant
    text immediately preceding it (the 'why I reached for this skill'
    moment). Critical for distilling skill-invocation patterns."""
    path = Path(args.jsonl)
    events = list(iter_events(path))
    hits = []
    for idx, (line, ev) in enumerate(events):
        if ev.get("type") != "assistant":
            continue
        msg = ev.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        # Walk content blocks to find Skill tool_use blocks
        preceding_text = ""
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                preceding_text = (block.get("text") or "").strip()
            elif block.get("type") == "tool_use" and block.get("name") == "Skill":
                inp = block.get("input") or {}
                hits.append((line, idx, inp.get("skill") or "?", inp.get("args") or "", preceding_text[-200:]))
                preceding_text = ""
    print(f"# {len(hits)} Skill invocations")
    for line, idx, skill, args_str, prev in hits:
        print(f"  L{line} (event#{idx}) Skill={skill}  args={(args_str or '')[:60]!r}")
        if prev:
            print(f"    preceded by: ...{prev}")


# ---------------------------------------------------------------------------
# Subcommand: phases — auto-segment into work phases
# ---------------------------------------------------------------------------

def cmd_phases(args):
    """Heuristic phase detection: segment the transcript into bursts of tool
    activity separated by either a user message or a long assistant text
    block (planning). Useful to see where the agent paused to re-evaluate."""
    path = Path(args.jsonl)
    events = list(iter_events(path))
    # Phase boundary markers: user messages, long assistant texts, mode changes
    boundaries = [0]
    for idx, (line, ev) in enumerate(events):
        t = ev.get("type")
        if t == "user":
            msg = ev.get("message") or {}
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                boundaries.append(idx)
            elif isinstance(content, list):
                # Only count human-authored text, not tool_result-only user events
                has_text = any(isinstance(c, dict) and c.get("type") == "text" for c in content)
                if has_text:
                    boundaries.append(idx)
        elif t == "assistant":
            msg = ev.get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        if len(c.get("text") or "") >= args.text_threshold:
                            boundaries.append(idx)
                            break
    boundaries.append(len(events))
    boundaries = sorted(set(boundaries))

    print(f"# {len(boundaries) - 1} phases (boundary = user msg OR assistant text >={args.text_threshold}ch)")
    for i in range(len(boundaries) - 1):
        start, end = boundaries[i], boundaries[i + 1]
        slice_events = events[start:end]
        tool_calls = Counter()
        for _, ev in slice_events:
            if ev.get("type") != "assistant":
                continue
            content = (ev.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    tool_calls[c.get("name") or "?"] += 1
        # Grab the boundary event's text as the phase "label"
        label = ""
        b_ev = events[start][1] if start < len(events) else {}
        b_content = (b_ev.get("message") or {}).get("content")
        if isinstance(b_content, str):
            label = b_content[:80]
        elif isinstance(b_content, list):
            for c in b_content:
                if isinstance(c, dict) and c.get("type") == "text":
                    label = (c.get("text") or "")[:80].replace("\n", " ")
                    break
        n = sum(tool_calls.values())
        top = ",".join(f"{nm}({cnt})" for nm, cnt in tool_calls.most_common(3))
        print(f"  phase {i:>2d}: events[{start}:{end}] tools={n:<4d} {top}")
        if label:
            print(f"    | {label}")


# ---------------------------------------------------------------------------
# Subcommand: compare — diff two transcripts
# ---------------------------------------------------------------------------

def cmd_compare(args):
    """Trajectory-level diff between two transcripts that did similar work.
    Surfaces: tool-frequency deltas, divergent trigrams, error patterns
    unique to each. This is the SkillGen contrastive analysis at trajectory
    level (the findings-jsonl version is `findings` subcommand)."""
    pa, pb = Path(args.a), Path(args.b)

    def tool_freq(p):
        return Counter(b.get("name") or "?" for _, b in iter_tool_uses(p))

    def trigrams(p):
        seq = [b.get("name") or "?" for _, b in iter_tool_uses(p)]
        return Counter(tuple(seq[i:i + 3]) for i in range(len(seq) - 2))

    def errors(p):
        names = []
        idx = {b.get("id"): b.get("name") for _, b in iter_tool_uses(p)}
        for _, b in iter_tool_results(p):
            if b.get("is_error"):
                names.append(idx.get(b.get("tool_use_id"), "?"))
        return Counter(names)

    fa, fb = tool_freq(pa), tool_freq(pb)
    print(f"# tool freq deltas (A={pa.name} vs B={pb.name})")
    all_tools = sorted(set(fa) | set(fb))
    rows = []
    for t in all_tools:
        a, b = fa.get(t, 0), fb.get(t, 0)
        rows.append((t, a, b, a - b))
    rows.sort(key=lambda r: -abs(r[3]))
    print(f"  {'tool':28s} {'A':>5s} {'B':>5s} {'Δ':>6s}")
    for t, a, b, d in rows[:25]:
        flag = "←A" if d > 5 else "B→" if d < -5 else "  "
        print(f"  {t:28s} {a:>5d} {b:>5d} {d:>+6d} {flag}")

    ta, tb = trigrams(pa), trigrams(pb)
    only_a = sorted(set(ta) - set(tb), key=lambda g: -ta[g])[:10]
    only_b = sorted(set(tb) - set(ta), key=lambda g: -tb[g])[:10]
    shared = sorted(set(ta) & set(tb), key=lambda g: -(ta[g] + tb[g]))[:10]
    print(f"# top shared trigrams")
    for g in shared:
        print(f"  A={ta[g]:>3d} B={tb[g]:>3d}  {' → '.join(g)}")
    print(f"# trigrams unique to A (top 10)")
    for g in only_a:
        print(f"  {ta[g]:>3d}  {' → '.join(g)}")
    print(f"# trigrams unique to B (top 10)")
    for g in only_b:
        print(f"  {tb[g]:>3d}  {' → '.join(g)}")

    ea, eb = errors(pa), errors(pb)
    print(f"# errored-tool deltas")
    all_err = sorted(set(ea) | set(eb))
    for t in all_err:
        print(f"  {t:28s} A={ea.get(t, 0):>3d}  B={eb.get(t, 0):>3d}")


# ---------------------------------------------------------------------------
# Subcommand: patterns — emit candidate skill rules
# ---------------------------------------------------------------------------

def cmd_patterns(args):
    """Mechanical extraction of candidate skill-rule shapes from a transcript.

    Emits JSON to stdout (or path with --out). The intent is for a human/LLM
    to read this short JSON, not the raw transcript, when drafting a skill.

    Patterns emitted:
      - top_workflows: 3- and 4-grams of tool calls (most-frequent sequences)
      - error_recovery: for each error, the tool sequence that followed (the recovery)
      - verify_after_search: count of Read/Edit immediately after Grep/text_search
      - skill_reaches: skills invoked + preceding-text snippets
      - subagent_dispatches: agent types + prompt categories
      - retried_pairs: tool/input shapes that were retried (suggests guard rules)
    """
    path = Path(args.jsonl)
    uses = list(iter_tool_uses(path))
    seq = [b.get("name") or "?" for _, b in uses]

    # Top workflows
    g3 = Counter(tuple(seq[i:i + 3]) for i in range(len(seq) - 2)).most_common(8)
    g4 = Counter(tuple(seq[i:i + 4]) for i in range(len(seq) - 3)).most_common(6)

    # Error recovery: pair (errored tool name, next 3 tool names)
    use_index = {b.get("id"): (i_idx, b.get("name"), b.get("input") or {}) for i_idx, (_, b) in enumerate(uses)}
    recoveries = []
    for _, b in iter_tool_results(path):
        if not b.get("is_error"):
            continue
        uid = b.get("tool_use_id")
        if uid not in use_index:
            continue
        i_idx, name, inp = use_index[uid]
        next_three = [uses[j][1].get("name") for j in range(i_idx + 1, min(len(uses), i_idx + 4))]
        recoveries.append({
            "errored_tool": name,
            "input_brief": _input_brief(inp),
            "recovery_sequence": next_three,
        })

    # Verify-after-search
    search_tools = {"Grep", "Glob", "mcp__scout__text_search", "mcp__scout__search", "WebSearch"}
    verify_tools = {"Read", "Edit", "mcp__scout__read_file"}
    verify_after_search = 0
    for i in range(len(seq) - 1):
        if seq[i] in search_tools and seq[i + 1] in verify_tools:
            verify_after_search += 1
    search_total = sum(1 for s in seq if s in search_tools)

    # Skill reaches
    skill_reaches = []
    for line, b in iter_tool_uses(path):
        if b.get("name") == "Skill":
            inp = b.get("input") or {}
            skill_reaches.append({
                "line": line,
                "skill": inp.get("skill"),
                "args": (inp.get("args") or "")[:120],
            })

    # Subagent dispatches
    agents = []
    for line, b in iter_tool_uses(path):
        if b.get("name") == "Agent":
            inp = b.get("input") or {}
            agents.append({
                "line": line,
                "subagent_type": inp.get("subagent_type") or "(general)",
                "description": inp.get("description"),
                "prompt_chars": len(inp.get("prompt") or ""),
            })

    # Retried pairs
    retries = []
    for i in range(len(uses)):
        line_i, bi = uses[i]
        name_i = bi.get("name")
        input_i = bi.get("input") or {}
        for j in range(i + 1, min(len(uses), i + 6)):
            line_j, bj = uses[j]
            if bj.get("name") != name_i:
                continue
            input_j = bj.get("input") or {}
            sim = _input_similarity(input_i, input_j)
            if sim >= 0.5:
                retries.append({
                    "tool": name_i,
                    "first_line": line_i,
                    "retry_line": line_j,
                    "input_similarity": round(sim, 2),
                    "input_brief": _input_brief(input_i),
                })
                break  # one retry pair per first-occurrence

    payload = {
        "session": path.name,
        "total_tool_calls": len(seq),
        "top_3grams": [{"gram": list(g), "count": c} for g, c in g3],
        "top_4grams": [{"gram": list(g), "count": c} for g, c in g4],
        "search_total": search_total,
        "verify_after_search": verify_after_search,
        "verify_ratio": round(verify_after_search / search_total, 2) if search_total else None,
        "error_recoveries": recoveries[:20],
        "skill_reaches": skill_reaches,
        "subagent_dispatches": agents,
        "retried_pairs": retries[:20],
    }
    out_json = json.dumps(payload, indent=2)
    if args.out:
        Path(args.out).write_text(out_json, encoding="utf-8")
        print(f"wrote {args.out} ({len(out_json)} bytes)")
    else:
        print(out_json)


# ---------------------------------------------------------------------------
# Subcommand: sample — random representative turns
# ---------------------------------------------------------------------------

def cmd_sample(args):
    """Deterministically sample N turns spread across the transcript so a
    human can spot-check the agent's behaviour without reading everything.
    Sampling is uniform stride (not random) — same input → same output."""
    path = Path(args.jsonl)
    events = list(iter_events(path))
    n = max(1, args.n)
    if len(events) <= n:
        picks = list(range(len(events)))
    else:
        step = len(events) / n
        picks = [int(i * step) for i in range(n)]
    print(f"# sampling {len(picks)} of {len(events)} events (uniform stride)")
    for idx in picks:
        line, ev = events[idx]
        t = ev.get("type")
        msg = ev.get("message") or {}
        content = msg.get("content")
        marker = f"[{idx:>5d}/{len(events)}]"
        if isinstance(content, str):
            print(f"{marker} L{line} {t}: {content[:200]}")
        elif isinstance(content, list):
            parts = []
            for c in content:
                if not isinstance(c, dict):
                    continue
                ct = c.get("type")
                if ct == "text":
                    parts.append(f"[text] {(c.get('text') or '')[:120]}")
                elif ct == "tool_use":
                    parts.append(f"[{c.get('name')}] {_input_brief(c.get('input') or {})}")
                elif ct == "tool_result":
                    cc = c.get("content")
                    if isinstance(cc, list):
                        cc = " ".join(
                            (b.get("text") or "") if isinstance(b, dict) else str(b)
                            for b in cc
                        )
                    err = "!" if c.get("is_error") else " "
                    parts.append(f"[result{err}] {str(cc or '')[:120].replace(chr(10), ' ')}")
            print(f"{marker} L{line} {t}: " + " | ".join(parts))
        else:
            print(f"{marker} L{line} {t}")


# ---------------------------------------------------------------------------
# Subcommand: report — one-shot distillation pre-pass
# ---------------------------------------------------------------------------

def cmd_report(args):
    """Run summary + tools + ngrams + agents + skills + errors + retries +
    phases + patterns, dump everything into one file. Read THIS instead of
    the raw transcript when distilling a skill."""
    path = Path(args.jsonl)
    out_path = Path(args.out) if args.out else path.with_suffix(".report.txt")
    import io
    buf = io.StringIO()
    real_stdout = sys.stdout

    def section(title):
        buf.write("\n" + "=" * 70 + "\n")
        buf.write(title + "\n")
        buf.write("=" * 70 + "\n")

    sys.stdout = buf
    try:
        section("SUMMARY")
        cmd_summary(argparse.Namespace(jsonl=str(path)))

        section("TOP TOOLS")
        cmd_tools(argparse.Namespace(jsonl=str(path), top=20))

        section("TOP 3-GRAMS")
        cmd_ngrams(argparse.Namespace(jsonl=str(path), n=3, top=15))

        section("TOP 4-GRAMS")
        cmd_ngrams(argparse.Namespace(jsonl=str(path), n=4, top=10))

        section("AGENT DISPATCHES")
        cmd_agents(argparse.Namespace(jsonl=str(path)))

        section("SKILL INVOCATIONS")
        cmd_skills(argparse.Namespace(jsonl=str(path)))

        section("ERRORS")
        cmd_errors(argparse.Namespace(jsonl=str(path)))

        section("SUSPECTED RETRIES")
        cmd_retries(argparse.Namespace(jsonl=str(path), window=5))

        section("LONG ASSISTANT TEXTS (PIVOTS)")
        cmd_pivots(argparse.Namespace(jsonl=str(path), min_text_chars=600))

        section("PHASES")
        cmd_phases(argparse.Namespace(jsonl=str(path), text_threshold=400))

        section("CANDIDATE SKILL PATTERNS (JSON)")
        cmd_patterns(argparse.Namespace(jsonl=str(path), out=None))
    finally:
        sys.stdout = real_stdout

    out_path.write_text(buf.getvalue(), encoding="utf-8")
    print(f"wrote {out_path} ({len(buf.getvalue()):,} chars, ~{len(buf.getvalue()) // 4:,} tokens)")


# ---------------------------------------------------------------------------
# CLI dispatch
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("sessions"); sp.add_argument("project_dir"); sp.set_defaults(func=cmd_sessions)
    sp = sub.add_parser("tools"); sp.add_argument("jsonl"); sp.add_argument("--top", type=int, default=15); sp.set_defaults(func=cmd_tools)
    sp = sub.add_parser("ngrams"); sp.add_argument("jsonl"); sp.add_argument("--n", type=int, default=3); sp.add_argument("--top", type=int, default=15); sp.set_defaults(func=cmd_ngrams)
    sp = sub.add_parser("retries"); sp.add_argument("jsonl"); sp.add_argument("--window", type=int, default=5); sp.set_defaults(func=cmd_retries)
    sp = sub.add_parser("errors"); sp.add_argument("jsonl"); sp.set_defaults(func=cmd_errors)
    sp = sub.add_parser("scope"); sp.add_argument("jsonl"); sp.add_argument("--worktree", required=True); sp.add_argument("--allow", action="append", default=[]); sp.set_defaults(func=cmd_scope)
    sp = sub.add_parser("findings"); sp.add_argument("a"); sp.add_argument("b"); sp.set_defaults(func=cmd_findings)
    sp = sub.add_parser("pivots"); sp.add_argument("jsonl"); sp.add_argument("--min-text-chars", type=int, default=600); sp.set_defaults(func=cmd_pivots)
    sp = sub.add_parser("slice"); sp.add_argument("jsonl"); sp.add_argument("--turn", type=int, required=True); sp.add_argument("--ctx", type=int, default=2); sp.set_defaults(func=cmd_slice)
    sp = sub.add_parser("summary"); sp.add_argument("jsonl"); sp.set_defaults(func=cmd_summary)
    sp = sub.add_parser("agents"); sp.add_argument("jsonl"); sp.set_defaults(func=cmd_agents)
    sp = sub.add_parser("skills"); sp.add_argument("jsonl"); sp.set_defaults(func=cmd_skills)
    sp = sub.add_parser("phases"); sp.add_argument("jsonl"); sp.add_argument("--text-threshold", type=int, default=400); sp.set_defaults(func=cmd_phases)
    sp = sub.add_parser("compare"); sp.add_argument("a"); sp.add_argument("b"); sp.set_defaults(func=cmd_compare)
    sp = sub.add_parser("patterns"); sp.add_argument("jsonl"); sp.add_argument("--out", default=None); sp.set_defaults(func=cmd_patterns)
    sp = sub.add_parser("sample"); sp.add_argument("jsonl"); sp.add_argument("--n", type=int, default=20); sp.set_defaults(func=cmd_sample)
    sp = sub.add_parser("report"); sp.add_argument("jsonl"); sp.add_argument("--out", default=None); sp.set_defaults(func=cmd_report)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
