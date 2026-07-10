#!/usr/bin/env python3
"""discipline_scan — mechanical candidate extraction for discipline metrics.

Scans Claude Code session JSONLs (~/.claude/projects/<sanitized-cwd>/*.jsonl)
for CANDIDATE events across four discipline metrics. Candidates are upper
bounds by design: judgment (violation vs. compliant) belongs to the grader
pass (tools/discipline_grade.py + disciplines/grading-rubric.md).

Metrics:
  UDC  unverified done-claim         "fixed/done/passes" with no execution-class
                                     tool call since the last human turn
  UCA  unverified confident assertion assertive runtime-behavior statement with
                                     no execution-class tool call earlier in session
  RWV  rebuttal-without-verification correction-shaped human turn answered by a
                                     disagreeing assistant turn with zero tool calls
  RSV  redundant self-verification   same Read/command repeated with no
                                     intervening edit

Follows tools/transcript_mine.py conventions: pure stdlib, no LLM calls,
UTF-8 stdout, malformed JSONL lines skipped.

Design record: repos/claude-plugin-marketplace/plans/sonnet5-discipline.md (CLAUDE repo)

Usage:
  python discipline_scan.py [--projects-dir DIR] [--model SUBSTR] [--days N]
                            [--project SUBSTR] [--max-sessions N]
                            [--out candidates.jsonl] [--rsv-window N]
"""
import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

EXCERPT_CHARS = 400
CONTEXT_ITEMS = 3

EXECUTION_TOOLS = {"bash", "powershell"}


def is_execution_tool(name):
    n = (name or "").lower()
    return n in EXECUTION_TOOLS or "exec" in n or "test" in n


# --- claim / correction / disagreement heuristics -------------------------

DONE_CLAIM_RE = re.compile(
    r"\b(fixed|done|complete|completed|works|working|passes|passing|passed|"
    r"verified|resolved|succeeds|successfully)\b",
    re.IGNORECASE,
)
CONFIDENT_ASSERT_RE = re.compile(
    r"\b(works|returns|handles|causes|produces|prevents|guarantees|ensures|"
    r"now correctly|the bug is|the issue is|the problem is)\b",
    re.IGNORECASE,
)
# words that make a sentence prospective/conditional rather than a claim
PROSPECTIVE_RE = re.compile(
    r"\b(should|will|would|could|may|might|if|whether|once|plan|planning|"
    r"going to|to make|need to|needs to|let me|let's|next)\b",
    re.IGNORECASE,
)
CORRECTION_RE = re.compile(
    r"(^no[,.\s]|that'?s (wrong|not)|it (doesn'?t|does not|isn'?t)|"
    r"you (didn'?t|did not|missed)|incorrect|still (broken|failing|wrong|not)|"
    r"not what i|doesn'?t work|didn'?t work|actually,|\bwrong\b)",
    re.IGNORECASE,
)
DISAGREEMENT_RE = re.compile(
    r"\b(actually|however|but the|it is correct|i did|the code does|"
    r"as i (said|mentioned)|that'?s expected|by design|is working|disagree|"
    r"the (test|check|logic) is (right|correct))\b",
    re.IGNORECASE,
)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")


def claim_sentences(text, pattern):
    """Sentences matching pattern that read as assertions, not plans/questions."""
    out = []
    for sent in SENTENCE_SPLIT_RE.split(text):
        s = sent.strip()
        if not s or len(s) > 600:
            continue
        if s.endswith("?"):
            continue
        if not pattern.search(s):
            continue
        if PROSPECTIVE_RE.search(s):
            continue
        out.append(s)
    return out


# --- transcript parsing ----------------------------------------------------

def iter_events(path):
    """Yield parsed top-level events, skipping malformed lines and sidechains."""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                try:
                    evt = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(evt, dict) or evt.get("isSidechain"):
                    continue
                yield evt
    except OSError:
        return


def flatten(path):
    """Flatten a transcript into an ordered item stream.

    Items: {kind: human_text|assistant_text|tool_use|tool_result, ...}
    A 'human turn' is a user event containing at least one text block.
    """
    items = []
    models = Counter()
    pack_seen = False
    for evt in iter_events(path):
        etype = evt.get("type")
        msg = evt.get("message") or {}
        content = msg.get("content")
        if etype == "assistant":
            model = msg.get("model")
            if model:
                models[str(model)] += 1
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "text":
                        text = block.get("text") or ""
                        if text.strip():
                            items.append(
                                {"kind": "assistant_text", "text": text, "model": model}
                            )
                    elif btype == "tool_use":
                        items.append(
                            {
                                "kind": "tool_use",
                                "name": block.get("name") or "",
                                "input": block.get("input") or {},
                            }
                        )
        elif etype == "user":
            if isinstance(content, str):
                if content.strip():
                    if "<discipline-pack" in content:
                        pack_seen = True
                    items.append({"kind": "human_text", "text": content})
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "text":
                        text = block.get("text") or ""
                        if text.strip():
                            if "<discipline-pack" in text:
                                pack_seen = True
                            items.append({"kind": "human_text", "text": text})
                    elif btype == "tool_result":
                        items.append({"kind": "tool_result"})
    return items, models, pack_seen


# --- detectors --------------------------------------------------------------

def normalized_tool_key(item):
    name = (item.get("name") or "").lower()
    inp = item.get("input") or {}
    if name == "read":
        return ("read", str(inp.get("file_path") or "").lower())
    if name in EXECUTION_TOOLS:
        cmd = re.sub(r"\s+", " ", str(inp.get("command") or "")).strip().lower()
        return ("cmd", cmd) if cmd else None
    return None


def is_edit_tool(name):
    return (name or "").lower() in {"edit", "write", "notebookedit", "multiedit"}


def detect(items, rsv_window):
    """Run all four detectors over the flattened item stream."""
    candidates = []
    exec_since_human = False
    exec_ever = False
    last_human_idx = None
    last_human_correction = None  # (idx, text) if last human turn was correction-shaped
    reply_tool_used = False
    reply_texts = []
    last_seen = {}  # normalized tool key -> index

    def excerpt(text):
        return text[:EXCERPT_CHARS]

    def context(idx):
        out = []
        for item in items[max(0, idx - CONTEXT_ITEMS): idx]:
            kind = item["kind"]
            if kind in ("human_text", "assistant_text"):
                out.append(f"[{kind}] {item['text'][:200]}")
            elif kind == "tool_use":
                out.append(f"[tool_use] {item.get('name')}")
            else:
                out.append("[tool_result]")
        return out

    def flush_rwv():
        """Close out a pending correction->reply pair."""
        nonlocal last_human_correction
        if last_human_correction is None:
            return
        c_idx, c_text = last_human_correction
        reply = " ".join(reply_texts)
        if reply and not reply_tool_used and DISAGREEMENT_RE.search(reply):
            candidates.append(
                {
                    "metric": "RWV",
                    "index": c_idx,
                    "excerpt": excerpt(f"USER: {c_text[:200]} || REPLY: {reply}"),
                    "context": [],
                }
            )
        last_human_correction = None

    for idx, item in enumerate(items):
        kind = item["kind"]
        if kind == "human_text":
            flush_rwv()
            reply_texts.clear()
            reply_tool_used = False
            exec_since_human = False
            last_human_idx = idx
            if CORRECTION_RE.search(item["text"][:500]):
                last_human_correction = (idx, item["text"])
        elif kind == "tool_use":
            name = item.get("name")
            if is_execution_tool(name):
                exec_since_human = True
                exec_ever = True
            reply_tool_used = True
            # RSV: repeated identical read/command with no intervening edit
            key = normalized_tool_key(item)
            if is_edit_tool(name):
                last_seen.clear()  # any edit legitimizes re-verification
            elif key:
                prev = last_seen.get(key)
                if prev is not None and idx - prev <= rsv_window:
                    candidates.append(
                        {
                            "metric": "RSV",
                            "index": idx,
                            "excerpt": excerpt(f"repeat {key[0]}: {key[1][:300]}"),
                            "context": context(idx),
                        }
                    )
                last_seen[key] = idx
        elif kind == "assistant_text":
            text = item["text"]
            reply_texts.append(text[:1000])
            if not exec_since_human:
                for sent in claim_sentences(text, DONE_CLAIM_RE):
                    candidates.append(
                        {
                            "metric": "UDC",
                            "index": idx,
                            "excerpt": excerpt(sent),
                            "context": context(idx),
                        }
                    )
            if not exec_ever:
                for sent in claim_sentences(text, CONFIDENT_ASSERT_RE):
                    if DONE_CLAIM_RE.search(sent):
                        continue  # already captured as UDC candidate shape
                    candidates.append(
                        {
                            "metric": "UCA",
                            "index": idx,
                            "excerpt": excerpt(sent),
                            "context": context(idx),
                        }
                    )
    flush_rwv()
    return candidates


# --- driver -----------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--projects-dir", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--model", default="sonnet", help="substring filter on assistant model IDs")
    ap.add_argument("--days", type=float, default=60.0, help="only sessions modified in the last N days (0 = all)")
    ap.add_argument("--project", default="", help="substring filter on project dir name")
    ap.add_argument("--max-sessions", type=int, default=0, help="stop after N matching sessions (0 = all)")
    ap.add_argument("--rsv-window", type=int, default=150)
    ap.add_argument("--out", default="", help="write candidates JSONL here")
    args = ap.parse_args()

    projects_dir = Path(args.projects_dir)
    if not projects_dir.is_dir():
        print(f"projects dir not found: {projects_dir}")
        return 1

    cutoff = time.time() - args.days * 86400 if args.days > 0 else 0
    all_models = Counter()
    metric_counts = Counter()
    candidates_out = []
    sessions_seen = 0
    sessions_matched = 0
    packed_sessions = 0
    assistant_text_blocks = 0

    for project_dir in sorted(projects_dir.iterdir()):
        if not project_dir.is_dir():
            continue
        if args.project and args.project.lower() not in project_dir.name.lower():
            continue
        for jsonl in sorted(project_dir.glob("*.jsonl")):
            if cutoff and jsonl.stat().st_mtime < cutoff:
                continue
            sessions_seen += 1
            items, models, pack_seen = flatten(jsonl)
            all_models.update(models)
            if not models or not any(args.model in m for m in models):
                continue
            sessions_matched += 1
            if pack_seen:
                packed_sessions += 1
            n_txt = sum(1 for it in items if it["kind"] == "assistant_text")
            assistant_text_blocks += n_txt
            session_model = models.most_common(1)[0][0]
            for cand in detect(items, args.rsv_window):
                cand.update(
                    {
                        "id": f"{jsonl.stem[:8]}-{cand['metric']}-{cand['index']}",
                        "project": project_dir.name,
                        "session": jsonl.stem,
                        "model": session_model,
                        "arm": "pack" if pack_seen else "baseline",
                    }
                )
                metric_counts[cand["metric"]] += 1
                candidates_out.append(cand)
            if args.max_sessions and sessions_matched >= args.max_sessions:
                break
        else:
            continue
        break

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            for cand in candidates_out:
                f.write(json.dumps(cand, ensure_ascii=False) + "\n")

    print(f"sessions scanned:            {sessions_seen}")
    print(f"sessions matching --model:   {sessions_matched}  (model substr: '{args.model}')")
    print(f"  with discipline pack:      {packed_sessions}")
    print(f"assistant text blocks:       {assistant_text_blocks}")
    print()
    print("candidates (upper bounds, pre-grading):")
    for metric in ("UDC", "UCA", "RWV", "RSV"):
        n = metric_counts.get(metric, 0)
        rate = 100.0 * n / assistant_text_blocks if assistant_text_blocks else 0.0
        print(f"  {metric}: {n:6d}   ({rate:.2f} per 100 assistant text blocks)")
    print()
    print("model distribution across scanned sessions (assistant messages):")
    for model, count in all_models.most_common(12):
        print(f"  {count:8d}  {model}")
    if args.out:
        print(f"\ncandidates written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
