// transcript-mine — mechanical mining of Claude Code session JSONLs.
// Pure Node.js stdlib. No LLM calls. No deps.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Event iteration
// ---------------------------------------------------------------------------

export async function* iterEvents(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    i++;
    if (!trimmed) continue;
    try { yield [i - 1, JSON.parse(trimmed)]; }
    catch { /* skip parse errors */ }
  }
}

export async function* iterToolUses(path) {
  for await (const [i, ev] of iterEvents(path)) {
    if (ev.type !== "assistant") continue;
    const content = (ev.message || {}).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "tool_use") {
        yield [i, block];
      }
    }
  }
}

export async function* iterToolResults(path) {
  for await (const [i, ev] of iterEvents(path)) {
    if (ev.type !== "user") continue;
    const content = (ev.message || {}).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "tool_result") {
        yield [i, block];
      }
    }
  }
}

export async function* iterAssistantText(path) {
  for await (const [i, ev] of iterEvents(path)) {
    if (ev.type !== "assistant") continue;
    const content = (ev.message || {}).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text") {
        const txt = block.text || "";
        if (txt.trim()) yield [i, txt];
      }
    }
  }
}

export async function* iterUserText(path) {
  for await (const [i, ev] of iterEvents(path)) {
    if (ev.type !== "user") continue;
    const content = (ev.message || {}).content;
    if (typeof content === "string" && content.trim()) {
      yield [i, content];
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text") {
          const txt = block.text || "";
          if (txt.trim()) yield [i, txt];
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function inputSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) return 0;
  let matches = 0;
  for (const k of keys) {
    if (String(a[k] ?? "").slice(0, 200) === String(b[k] ?? "").slice(0, 200)) matches++;
  }
  return matches / keys.size;
}

export function inputBrief(d) {
  if (!d || !Object.keys(d).length) return "(empty)";
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    let s = String(v).replace(/\n/g, " ");
    if (s.length > 60) s = s.slice(0, 57) + "...";
    parts.push(`${k}=${s}`);
    const total = parts.reduce((a, p) => a + p.length, 0);
    if (total > 180) break;
  }
  return parts.join(", ");
}

export function normalizePath(p) {
  if (!p) return p;
  p = p.replace(/\\/g, "/");
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) p = `${m[1].toLowerCase()}:/${m[2]}`;
  return p.toLowerCase().replace(/\/$/, "");
}

// topN(counter, n) → [[key, count], ...] sorted descending
function topN(counter, n) {
  return Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---------------------------------------------------------------------------
// Subcommand: sessions
// ---------------------------------------------------------------------------

export async function cmdSessions(projectDir) {
  const files = readdirSync(projectDir)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .map(f => join(projectDir, f));
  if (!files.length) {
    console.log(`(no .jsonl sessions in ${projectDir})`);
    return;
  }
  const rows = [];
  for (const p of files) {
    let events = 0, toolUses = 0, errors = 0;
    const toolCounter = {};
    for await (const [, ev] of iterEvents(p)) { events++; void ev; }
    for await (const [, b] of iterToolUses(p)) {
      toolUses++;
      const n = b.name || "?";
      toolCounter[n] = (toolCounter[n] || 0) + 1;
    }
    for await (const [, b] of iterToolResults(p)) {
      if (b.is_error) errors++;
    }
    const top = topN(toolCounter, 3).map(([n, c]) => `${n}(${c})`).join(",");
    const sizeKb = statSync(p).size >> 10;
    const stem = basename(p).replace(/\.jsonl$/, "");
    rows.push({ session: stem, sizeKb, events, toolUses, errors, top });
  }
  console.log(`${"session".padEnd(38)} ${"size_kb".padStart(8)} ${"events".padStart(7)} ${"tools".padStart(6)} ${"err".padStart(4)}  top`);
  for (const r of rows) {
    console.log(`${r.session.padEnd(38)} ${String(r.sizeKb).padStart(8)} ${String(r.events).padStart(7)} ${String(r.toolUses).padStart(6)} ${String(r.errors).padStart(4)}  ${r.top}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: tools
// ---------------------------------------------------------------------------

export async function cmdTools(jsonl, top = 15) {
  const counter = {};
  const byCaller = {};
  for await (const [, b] of iterToolUses(jsonl)) {
    const name = b.name || "?";
    const rawCaller = b.caller;
    const caller = rawCaller && typeof rawCaller === "object"
      ? (rawCaller.type || rawCaller.name || "?")
      : (rawCaller || "main");
    counter[name] = (counter[name] || 0) + 1;
    if (!byCaller[caller]) byCaller[caller] = {};
    byCaller[caller][name] = (byCaller[caller][name] || 0) + 1;
  }
  const total = Object.values(counter).reduce((s, c) => s + c, 0);
  console.log(`${"tool".padEnd(32)} ${"count".padStart(6)}  ${"pct".padStart(5)}`);
  for (const [name, c] of topN(counter, top)) {
    console.log(`${name.padEnd(32)} ${String(c).padStart(6)}  ${(100 * c / total).toFixed(1).padStart(4)}%`);
  }
  const callerKeys = Object.keys(byCaller);
  if (callerKeys.length > 1) {
    console.log("---by caller---");
    for (const [caller, ctr] of Object.entries(byCaller)) {
      const t = topN(ctr, 5).map(([n, c]) => `${n}(${c})`).join(",");
      const sum = Object.values(ctr).reduce((s, c) => s + c, 0);
      console.log(`  ${caller}: ${sum} calls — ${t}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: ngrams
// ---------------------------------------------------------------------------

export async function cmdNgrams(jsonl, n = 3, top = 15) {
  const seq = [];
  for await (const [, b] of iterToolUses(jsonl)) seq.push(b.name || "?");
  if (seq.length < n) { console.log(`(too few tool calls for n=${n})`); return; }
  const grams = {};
  for (let i = 0; i <= seq.length - n; i++) {
    const k = seq.slice(i, i + n).join("\x00");
    grams[k] = (grams[k] || 0) + 1;
  }
  console.log(`# top ${top} ${n}-grams over ${seq.length} tool calls`);
  for (const [k, c] of topN(grams, top)) {
    console.log(`  ${String(c).padStart(4)}  ${k.split("\x00").join(" → ")}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: retries
// ---------------------------------------------------------------------------

export async function cmdRetries(jsonl, window = 5) {
  const uses = [];
  for await (const pair of iterToolUses(jsonl)) uses.push(pair);
  const hits = [];
  for (let i = 0; i < uses.length; i++) {
    const [lineI, bi] = uses[i];
    const nameI = bi.name;
    const inputI = bi.input || {};
    for (let j = i + 1; j < Math.min(uses.length, i + 1 + window); j++) {
      const [lineJ, bj] = uses[j];
      if (bj.name !== nameI) continue;
      const inputJ = bj.input || {};
      const sim = inputSimilarity(inputI, inputJ);
      if (sim >= 0.5) {
        hits.push([lineI, lineJ, nameI, sim, inputBrief(inputI), inputBrief(inputJ)]);
      }
    }
  }
  console.log(`# ${hits.length} suspected retries (same tool within ${window} calls, ≥50% input overlap)`);
  for (const [lineI, lineJ, name, sim, a, b] of hits.slice(0, 50)) {
    console.log(`  L${lineI}→L${lineJ} ${name} sim=${Math.round(sim * 100)}%`);
    console.log(`    a: ${a}`);
    console.log(`    b: ${b}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: errors
// ---------------------------------------------------------------------------

export async function cmdErrors(jsonl) {
  const useIndex = {};
  for await (const [line, b] of iterToolUses(jsonl)) {
    useIndex[b.id] = [line, b.name, b.input || {}];
  }
  const errs = [];
  for await (const [line, b] of iterToolResults(jsonl)) {
    if (!b.is_error) continue;
    const uid = b.tool_use_id;
    const [useLine, name, inp] = useIndex[uid] || [null, "?", {}];
    let content = b.content;
    if (Array.isArray(content)) {
      content = content.map(c => (c && typeof c === "object" ? c.text || "" : String(c))).join(" | ");
    }
    content = String(content || "").replace(/\n/g, " ");
    if (content.length > 240) content = content.slice(0, 237) + "...";
    errs.push([useLine, line, name, inputBrief(inp), content]);
  }
  console.log(`# ${errs.length} errored tool calls`);
  for (const [useLine, resLine, name, inp, msg] of errs) {
    console.log(`  L${useLine}→L${resLine} ${name}(${inp})`);
    console.log(`    !! ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: scope
// ---------------------------------------------------------------------------

const FILE_TOOLS = { Read: "file_path", Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path", Glob: "path", Grep: "path" };
const BASH_PATH_RE = /(?:[A-Za-z]:[\\/]|\/[a-z]\/|\.\/|\.\.\/|\/)[\w./\\\-]+/g;

export async function cmdScope(jsonl, worktree, allow = []) {
  const wt = worktree ? normalizePath(worktree) : null;
  const touched = {};
  const outOfScope = [];
  for await (const [line, b] of iterToolUses(jsonl)) {
    const name = b.name;
    const inp = b.input || {};
    const candidates = [];
    if (FILE_TOOLS[name]) {
      const p = inp[FILE_TOOLS[name]];
      if (p) candidates.push(p);
    } else if (name === "Bash") {
      const cmd = String(inp.command || "");
      const found = [...cmd.matchAll(BASH_PATH_RE)].map(m => m[0]).slice(0, 5);
      candidates.push(...found);
    }
    for (const p of candidates) {
      const np = normalizePath(p);
      touched[np] = (touched[np] || 0) + 1;
      if (wt && !(np.startsWith(wt + "/") || np === wt)) {
        if (allow.length && allow.some(a => np.startsWith(normalizePath(a)))) continue;
        outOfScope.push([line, name, np]);
      }
    }
  }
  const total = Object.values(touched).reduce((s, c) => s + c, 0);
  console.log(`# ${Object.keys(touched).length} distinct paths touched (${total} ops)`);
  console.log("# top 20 paths:");
  for (const [p, c] of topN(touched, 20)) {
    const flag = wt && !(p.startsWith(wt + "/") || p === wt) ? "⚠" : " ";
    console.log(`  ${flag} ${String(c).padStart(4)}  ${p}`);
  }
  if (wt) {
    console.log(`# ${outOfScope.length} out-of-scope ops (worktree=${wt})`);
    for (const [line, name, p] of outOfScope.slice(0, 30)) {
      console.log(`  L${line} ${name} ${p}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: findings
// ---------------------------------------------------------------------------

function loadFindings(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(l => l.trim())
    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function cmdFindings(pathA, pathB) {
  const a = loadFindings(pathA);
  const b = loadFindings(pathB);
  console.log(`# A: ${a.length} findings   B: ${b.length} findings`);
  const sevA = {}, sevB = {};
  for (const r of a) { const s = r.severity; sevA[s] = (sevA[s] || 0) + 1; }
  for (const r of b) { const s = r.severity; sevB[s] = (sevB[s] || 0) + 1; }
  console.log("# severity:");
  console.log(`  A: ${JSON.stringify(sevA)}`);
  console.log(`  B: ${JSON.stringify(sevB)}`);
  const key = r => `${normalizePath(r.file || "")}\x00${r.signal || ""}`;
  const keysA = Object.fromEntries(a.map(r => [key(r), r]));
  const keysB = Object.fromEntries(b.map(r => [key(r), r]));
  const setA = new Set(Object.keys(keysA));
  const setB = new Set(Object.keys(keysB));
  const both = [...setA].filter(k => setB.has(k)).sort();
  const onlyA = [...setA].filter(k => !setB.has(k)).sort();
  const onlyB = [...setB].filter(k => !setA.has(k)).sort();
  console.log(`# overlap: both=${both.length}  A-only=${onlyA.length}  B-only=${onlyB.length}`);
  console.log("# HIGH-CONFIDENCE (both agents flagged same file+signal):");
  for (const k of both) {
    const [ra, rb] = [keysA[k], keysB[k]];
    const [sa, sb] = [ra.severity, rb.severity];
    const agree = sa === sb ? "=" : "≠";
    const [file, signal] = k.split("\x00");
    console.log(`  ${agree} [${sa}/${sb}] ${file} :: ${signal}`);
    console.log(`    A: ${String(ra.summary || "").slice(0, 120)}`);
    console.log(`    B: ${String(rb.summary || "").slice(0, 120)}`);
  }
  console.log("# A-ONLY (A's unique signals):");
  for (const k of onlyA.slice(0, 20)) {
    const r = keysA[k];
    const [file, signal] = k.split("\x00");
    console.log(`  [${r.severity}] ${file} :: ${signal} — ${String(r.summary || "").slice(0, 90)}`);
  }
  console.log("# B-ONLY (B's unique signals):");
  for (const k of onlyB.slice(0, 20)) {
    const r = keysB[k];
    const [file, signal] = k.split("\x00");
    console.log(`  [${r.severity}] ${file} :: ${signal} — ${String(r.summary || "").slice(0, 90)}`);
  }
  const filesASigs = {}, filesBSigs = {};
  for (const r of a) {
    const f = normalizePath(r.file || "");
    if (!filesASigs[f]) filesASigs[f] = new Set();
    filesASigs[f].add(r.signal);
  }
  for (const r of b) {
    const f = normalizePath(r.file || "");
    if (!filesBSigs[f]) filesBSigs[f] = new Set();
    filesBSigs[f].add(r.signal);
  }
  const diverge = [];
  for (const f of Object.keys(filesASigs)) {
    if (!filesBSigs[f]) continue;
    const shared = [...filesASigs[f]].filter(s => filesBSigs[f].has(s));
    if (!shared.length) diverge.push([f, filesASigs[f], filesBSigs[f]]);
  }
  if (diverge.length) {
    console.log(`# DISAGREEMENT ON ROOT CAUSE (same file, no shared signal type): ${diverge.length}`);
    for (const [f, sa, sb] of diverge.slice(0, 15)) {
      console.log(`  ${f}: A=${JSON.stringify([...sa].sort())}  B=${JSON.stringify([...sb].sort())}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: pivots
// ---------------------------------------------------------------------------

export async function cmdPivots(jsonl, minTextChars = 600) {
  const hits = [];
  for await (const [line, txt] of iterAssistantText(jsonl)) {
    if (txt.length >= minTextChars) {
      const first = txt.trim().split("\n")[0].slice(0, 140);
      hits.push([line, txt.length, first]);
    }
  }
  console.log(`# ${hits.length} long assistant text blocks (≥${minTextChars} chars)`);
  for (const [line, n, first] of hits.slice(0, 40)) {
    console.log(`  L${String(line).padStart(6)}  ${String(n).padStart(5)}ch  ${first}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: slice
// ---------------------------------------------------------------------------

export async function cmdSlice(jsonl, turn, ctx = 2) {
  const events = [];
  for await (const pair of iterEvents(jsonl)) events.push(pair);
  const lo = Math.max(0, turn - ctx);
  const hi = Math.min(events.length, turn + ctx + 1);
  for (const [lineIdx, ev] of events.slice(lo, hi)) {
    const t = ev.type;
    const content = (ev.message || {}).content;
    const marker = lineIdx === turn ? ">>>" : "   ";
    if (typeof content === "string") {
      console.log(`${marker} L${lineIdx} ${t}: ${content.slice(0, 300)}`);
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text") parts.push(`[text] ${String(c.text || "").slice(0, 150)}`);
        else if (c.type === "tool_use") parts.push(`[tool_use] ${c.name}(${inputBrief(c.input || {})})`);
        else if (c.type === "tool_result") {
          let cc = c.content;
          if (Array.isArray(cc)) cc = cc.map(b => (b && typeof b === "object" ? b.text || "" : String(b))).join(" ");
          const err = c.is_error ? "!" : " ";
          parts.push(`[tool_result${err}] ${String(cc || "").slice(0, 150).replace(/\n/g, " ")}`);
        }
      }
      console.log(`${marker} L${lineIdx} ${t}: ${parts.join(" | ")}`);
    } else {
      console.log(`${marker} L${lineIdx} ${t}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: summary
// ---------------------------------------------------------------------------

export async function cmdSummary(jsonl) {
  const sizeKb = statSync(jsonl).size >> 10;
  let events = 0, errs = 0, longTexts = 0, userMsgs = 0;
  const toolUses = [];
  const errExamples = [];
  for await (const [, ev] of iterEvents(jsonl)) events++;
  for await (const [line, b] of iterToolUses(jsonl)) {
    toolUses.push([line, b.name || "?", b.input || {}, b.id]);
  }
  const useById = Object.fromEntries(toolUses.map(([line, name, inp, id]) => [id, [line, name, inp]]));
  for await (const [, b] of iterToolResults(jsonl)) {
    if (!b.is_error) continue;
    errs++;
    if (errExamples.length < 5) {
      const [ul, name, inp] = useById[b.tool_use_id] || [null, "?", {}];
      let content = b.content;
      if (Array.isArray(content)) content = content.map(c => (c && typeof c === "object" ? c.text || "" : String(c))).join(" | ");
      errExamples.push([ul, name, inputBrief(inp), String(content || "").slice(0, 200).replace(/\n/g, " ")]);
    }
  }
  for await (const [, txt] of iterAssistantText(jsonl)) { if (txt.length >= 600) longTexts++; }
  for await (const _ of iterUserText(jsonl)) userMsgs++;
  const toolCounter = {};
  for (const [, name] of toolUses) toolCounter[name] = (toolCounter[name] || 0) + 1;
  let retries = 0;
  for (let i = 0; i < toolUses.length; i++) {
    const [, nameI, inpI] = toolUses[i];
    for (let j = i + 1; j < Math.min(toolUses.length, i + 6); j++) {
      const [, nameJ, inpJ] = toolUses[j];
      if (nameJ === nameI && inputSimilarity(inpI, inpJ) >= 0.5) { retries++; break; }
    }
  }
  const seq = toolUses.map(([, n]) => n);
  const trigrams = {};
  for (let i = 0; i <= seq.length - 3; i++) {
    const k = seq.slice(i, i + 3).join("\x00");
    trigrams[k] = (trigrams[k] || 0) + 1;
  }
  console.log(`# transcript_mine summary :: ${basename(jsonl)}`);
  console.log(`  size: ${sizeKb} KB   events: ${events}   tool_uses: ${toolUses.length}`);
  console.log(`  user_messages: ${userMsgs}   long_assistant_texts (≥600ch): ${longTexts}`);
  console.log(`  errored tool calls: ${errs}   suspected retries: ${retries}`);
  console.log(`  tools used: ${Object.keys(toolCounter).length} distinct`);
  console.log("# top 8 tools");
  for (const [n, c] of topN(toolCounter, 8)) console.log(`  ${String(c).padStart(5)}  ${n}`);
  const topTrigrams = topN(trigrams, 5);
  if (topTrigrams.length) {
    console.log("# top 5 tool trigrams");
    for (const [k, c] of topTrigrams) console.log(`  ${String(c).padStart(5)}  ${k.split("\x00").join(" → ")}`);
  }
  if (errExamples.length) {
    console.log("# first 5 errors");
    for (const [ul, name, inp, msg] of errExamples) {
      console.log(`  L${ul} ${name}(${inp})`);
      console.log(`    !! ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: agents
// ---------------------------------------------------------------------------

export async function cmdAgents(jsonl) {
  const useIndex = {};
  for await (const [line, b] of iterToolUses(jsonl)) {
    if (b.name === "Agent") useIndex[b.id] = [line, b.input || {}];
  }
  if (!Object.keys(useIndex).length) {
    console.log("# no Agent tool dispatches in this session");
    return;
  }
  const results = {};
  for await (const [line, b] of iterToolResults(jsonl)) {
    const uid = b.tool_use_id;
    if (!useIndex[uid]) continue;
    let content = b.content;
    if (Array.isArray(content)) content = content.map(c => (c && typeof c === "object" ? c.text || "" : String(c))).join(" ");
    results[uid] = [line, String(content || "")];
  }
  console.log(`# ${Object.keys(useIndex).length} Agent dispatches`);
  for (const [uid, [line, inp]] of Object.entries(useIndex)) {
    const subagent = inp.subagent_type || "(general)";
    const desc = String(inp.description || "").slice(0, 60);
    const prompt = String(inp.prompt || "").replace(/\n/g, " ");
    const [resLine, res] = results[uid] || [null, ""];
    console.log(`  L${line} [${subagent}] ${desc}`);
    console.log(`    prompt (${prompt.length}ch): ${prompt.slice(0, 180)}`);
    if (res) console.log(`    result L${resLine} (${res.length}ch): ${res.slice(0, 180)}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: skills
// ---------------------------------------------------------------------------

export async function cmdSkills(jsonl) {
  const events = [];
  for await (const pair of iterEvents(jsonl)) events.push(pair);
  const hits = [];
  for (let idx = 0; idx < events.length; idx++) {
    const [line, ev] = events[idx];
    if (ev.type !== "assistant") continue;
    const content = (ev.message || {}).content;
    if (!Array.isArray(content)) continue;
    let precedingText = "";
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        precedingText = String(block.text || "").trim();
      } else if (block.type === "tool_use" && block.name === "Skill") {
        const inp = block.input || {};
        hits.push([line, idx, inp.skill || "?", inp.args || "", precedingText.slice(-200)]);
        precedingText = "";
      }
    }
  }
  console.log(`# ${hits.length} Skill invocations`);
  for (const [line, idx, skill, argsStr, prev] of hits) {
    console.log(`  L${line} (event#${idx}) Skill=${skill}  args=${JSON.stringify(String(argsStr || "").slice(0, 60))}`);
    if (prev) console.log(`    preceded by: ...${prev}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: phases
// ---------------------------------------------------------------------------

export async function cmdPhases(jsonl, textThreshold = 400) {
  const events = [];
  for await (const pair of iterEvents(jsonl)) events.push(pair);
  const boundaries = new Set([0]);
  for (let idx = 0; idx < events.length; idx++) {
    const [, ev] = events[idx];
    const t = ev.type;
    if (t === "user") {
      const content = (ev.message || {}).content;
      if (typeof content === "string" && content.trim()) {
        boundaries.add(idx);
      } else if (Array.isArray(content)) {
        if (content.some(c => c && typeof c === "object" && c.type === "text")) boundaries.add(idx);
      }
    } else if (t === "assistant") {
      const content = (ev.message || {}).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === "object" && c.type === "text" && String(c.text || "").length >= textThreshold) {
            boundaries.add(idx);
            break;
          }
        }
      }
    }
  }
  boundaries.add(events.length);
  const sorted = [...boundaries].sort((a, b) => a - b);
  console.log(`# ${sorted.length - 1} phases (boundary = user msg OR assistant text >=${textThreshold}ch)`);
  for (let i = 0; i < sorted.length - 1; i++) {
    const [start, end] = [sorted[i], sorted[i + 1]];
    const toolCalls = {};
    for (const [, ev] of events.slice(start, end)) {
      if (ev.type !== "assistant") continue;
      const content = (ev.message || {}).content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c && typeof c === "object" && c.type === "tool_use") {
          const n = c.name || "?";
          toolCalls[n] = (toolCalls[n] || 0) + 1;
        }
      }
    }
    const [, bEv] = events[start] || [null, {}];
    const bContent = (bEv.message || {}).content;
    let label = "";
    if (typeof bContent === "string") {
      label = bContent.slice(0, 80);
    } else if (Array.isArray(bContent)) {
      for (const c of bContent) {
        if (c && typeof c === "object" && c.type === "text") {
          label = String(c.text || "").slice(0, 80).replace(/\n/g, " ");
          break;
        }
      }
    }
    const n = Object.values(toolCalls).reduce((s, c) => s + c, 0);
    const top = topN(toolCalls, 3).map(([nm, cnt]) => `${nm}(${cnt})`).join(",");
    console.log(`  phase ${String(i).padStart(2)}: events[${start}:${end}] tools=${String(n).padEnd(4)} ${top}`);
    if (label) console.log(`    | ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: compare
// ---------------------------------------------------------------------------

export async function cmdCompare(pathA, pathB) {
  async function toolFreq(p) {
    const c = {};
    for await (const [, b] of iterToolUses(p)) { const n = b.name || "?"; c[n] = (c[n] || 0) + 1; }
    return c;
  }
  async function trigrams(p) {
    const seq = [];
    for await (const [, b] of iterToolUses(p)) seq.push(b.name || "?");
    const g = {};
    for (let i = 0; i <= seq.length - 3; i++) { const k = seq.slice(i, i + 3).join("\x00"); g[k] = (g[k] || 0) + 1; }
    return g;
  }
  async function errors(p) {
    const idx = {};
    for await (const [, b] of iterToolUses(p)) idx[b.id] = b.name;
    const c = {};
    for await (const [, b] of iterToolResults(p)) {
      if (b.is_error) { const n = idx[b.tool_use_id] || "?"; c[n] = (c[n] || 0) + 1; }
    }
    return c;
  }
  const [fa, fb] = await Promise.all([toolFreq(pathA), toolFreq(pathB)]);
  const nameA = basename(pathA), nameB = basename(pathB);
  console.log(`# tool freq deltas (A=${nameA} vs B=${nameB})`);
  const allTools = [...new Set([...Object.keys(fa), ...Object.keys(fb)])];
  const rows = allTools.map(t => [t, fa[t] || 0, fb[t] || 0, (fa[t] || 0) - (fb[t] || 0)]);
  rows.sort((x, y) => Math.abs(y[3]) - Math.abs(x[3]));
  console.log(`  ${"tool".padEnd(28)} ${"A".padStart(5)} ${"B".padStart(5)} ${"Δ".padStart(6)}`);
  for (const [t, a, b, d] of rows.slice(0, 25)) {
    const flag = d > 5 ? "←A" : d < -5 ? "B→" : "  ";
    console.log(`  ${t.padEnd(28)} ${String(a).padStart(5)} ${String(b).padStart(5)} ${(d >= 0 ? "+" : "") + d.toString().padStart(5)} ${flag}`);
  }
  const [ta, tb] = await Promise.all([trigrams(pathA), trigrams(pathB)]);
  const setTA = new Set(Object.keys(ta)), setTB = new Set(Object.keys(tb));
  const onlyA = [...setTA].filter(k => !setTB.has(k)).sort((a, b) => ta[b] - ta[a]).slice(0, 10);
  const onlyB = [...setTB].filter(k => !setTA.has(k)).sort((a, b) => tb[b] - tb[a]).slice(0, 10);
  const shared = [...setTA].filter(k => setTB.has(k)).sort((a, b) => (tb[b] + ta[b]) - (tb[a] + ta[a])).slice(0, 10);
  console.log("# top shared trigrams");
  for (const g of shared) console.log(`  A=${String(ta[g]).padStart(3)} B=${String(tb[g]).padStart(3)}  ${g.split("\x00").join(" → ")}`);
  console.log("# trigrams unique to A (top 10)");
  for (const g of onlyA) console.log(`  ${String(ta[g]).padStart(3)}  ${g.split("\x00").join(" → ")}`);
  console.log("# trigrams unique to B (top 10)");
  for (const g of onlyB) console.log(`  ${String(tb[g]).padStart(3)}  ${g.split("\x00").join(" → ")}`);
  const [ea, eb] = await Promise.all([errors(pathA), errors(pathB)]);
  console.log("# errored-tool deltas");
  for (const t of [...new Set([...Object.keys(ea), ...Object.keys(eb)])]) {
    console.log(`  ${t.padEnd(28)} A=${String(ea[t] || 0).padStart(3)}  B=${String(eb[t] || 0).padStart(3)}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: patterns
// ---------------------------------------------------------------------------

export async function cmdPatterns(jsonl, out = null) {
  const uses = [];
  for await (const pair of iterToolUses(jsonl)) uses.push(pair);
  const seq = uses.map(([, b]) => b.name || "?");
  const cnt3 = {}, cnt4 = {};
  for (let i = 0; i <= seq.length - 3; i++) { const k = seq.slice(i, i + 3).join("\x00"); cnt3[k] = (cnt3[k] || 0) + 1; }
  for (let i = 0; i <= seq.length - 4; i++) { const k = seq.slice(i, i + 4).join("\x00"); cnt4[k] = (cnt4[k] || 0) + 1; }
  const top3 = topN(cnt3, 8);
  const top4 = topN(cnt4, 6);
  const useIndex = Object.fromEntries(uses.map(([, b], i) => [b.id, [i, b.name, b.input || {}]]));
  const recoveries = [];
  for await (const [, b] of iterToolResults(jsonl)) {
    if (!b.is_error) continue;
    const uid = b.tool_use_id;
    if (!useIndex[uid]) continue;
    const [iIdx, name, inp] = useIndex[uid];
    const nextThree = uses.slice(iIdx + 1, iIdx + 4).map(([, b2]) => b2.name);
    recoveries.push({ errored_tool: name, input_brief: inputBrief(inp), recovery_sequence: nextThree });
  }
  const searchTools = new Set(["Grep", "Glob", "mcp__scout__text_search", "mcp__scout__search", "WebSearch"]);
  const verifyTools = new Set(["Read", "Edit", "mcp__scout__read_file"]);
  let verifyAfterSearch = 0;
  for (let i = 0; i < seq.length - 1; i++) {
    if (searchTools.has(seq[i]) && verifyTools.has(seq[i + 1])) verifyAfterSearch++;
  }
  const searchTotal = seq.filter(s => searchTools.has(s)).length;
  const skillReaches = [];
  const agents = [];
  for (const [line, b] of uses) {
    if (b.name === "Skill") {
      const inp = b.input || {};
      skillReaches.push({ line, skill: inp.skill, args: String(inp.args || "").slice(0, 120) });
    } else if (b.name === "Agent") {
      const inp = b.input || {};
      agents.push({ line, subagent_type: inp.subagent_type || "(general)", description: inp.description, prompt_chars: String(inp.prompt || "").length });
    }
  }
  const retries = [];
  for (let i = 0; i < uses.length; i++) {
    const [lineI, bi] = uses[i];
    const nameI = bi.name;
    const inputI = bi.input || {};
    for (let j = i + 1; j < Math.min(uses.length, i + 6); j++) {
      const [lineJ, bj] = uses[j];
      if (bj.name !== nameI) continue;
      const sim = inputSimilarity(inputI, bj.input || {});
      if (sim >= 0.5) {
        retries.push({ tool: nameI, first_line: lineI, retry_line: lineJ, input_similarity: Math.round(sim * 100) / 100, input_brief: inputBrief(inputI) });
        break;
      }
    }
  }
  const payload = {
    session: basename(jsonl),
    total_tool_calls: seq.length,
    top_3grams: top3.map(([k, c]) => ({ gram: k.split("\x00"), count: c })),
    top_4grams: top4.map(([k, c]) => ({ gram: k.split("\x00"), count: c })),
    search_total: searchTotal,
    verify_after_search: verifyAfterSearch,
    verify_ratio: searchTotal ? Math.round(verifyAfterSearch / searchTotal * 100) / 100 : null,
    error_recoveries: recoveries.slice(0, 20),
    skill_reaches: skillReaches,
    subagent_dispatches: agents,
    retried_pairs: retries.slice(0, 20),
  };
  const outJson = JSON.stringify(payload, null, 2);
  if (out) {
    writeFileSync(out, outJson, "utf8");
    console.log(`wrote ${out} (${outJson.length} bytes)`);
  } else {
    console.log(outJson);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: sample
// ---------------------------------------------------------------------------

export async function cmdSample(jsonl, n = 20) {
  const events = [];
  for await (const pair of iterEvents(jsonl)) events.push(pair);
  const count = Math.max(1, n);
  const picks = events.length <= count
    ? [...Array(events.length)].map((_, i) => i)
    : [...Array(count)].map((_, i) => Math.floor(i * events.length / count));
  console.log(`# sampling ${picks.length} of ${events.length} events (uniform stride)`);
  for (const idx of picks) {
    const [line, ev] = events[idx];
    const t = ev.type;
    const content = (ev.message || {}).content;
    const marker = `[${String(idx).padStart(5)}/${events.length}]`;
    if (typeof content === "string") {
      console.log(`${marker} L${line} ${t}: ${content.slice(0, 200)}`);
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text") parts.push(`[text] ${String(c.text || "").slice(0, 120)}`);
        else if (c.type === "tool_use") parts.push(`[${c.name}] ${inputBrief(c.input || {})}`);
        else if (c.type === "tool_result") {
          let cc = c.content;
          if (Array.isArray(cc)) cc = cc.map(b => (b && typeof b === "object" ? b.text || "" : String(b))).join(" ");
          const err = c.is_error ? "!" : " ";
          parts.push(`[result${err}] ${String(cc || "").slice(0, 120).replace(/\n/g, " ")}`);
        }
      }
      console.log(`${marker} L${line} ${t}: ${parts.join(" | ")}`);
    } else {
      console.log(`${marker} L${line} ${t}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: report
// ---------------------------------------------------------------------------

export async function cmdReport(jsonl, out = null) {
  const outPath = out || jsonl.replace(/\.jsonl$/, "") + ".report.txt";
  const lines = [];
  const origLog = console.log;
  const capture = fn => { console.log = (...a) => lines.push(a.map(String).join(" ")); return fn().finally(() => { console.log = origLog; }); };
  const section = t => lines.push("", "=".repeat(70), t, "=".repeat(70));
  section("SUMMARY"); await capture(() => cmdSummary(jsonl));
  section("TOP TOOLS"); await capture(() => cmdTools(jsonl, 20));
  section("TOP 3-GRAMS"); await capture(() => cmdNgrams(jsonl, 3, 15));
  section("TOP 4-GRAMS"); await capture(() => cmdNgrams(jsonl, 4, 10));
  section("AGENT DISPATCHES"); await capture(() => cmdAgents(jsonl));
  section("SKILL INVOCATIONS"); await capture(() => cmdSkills(jsonl));
  section("ERRORS"); await capture(() => cmdErrors(jsonl));
  section("SUSPECTED RETRIES"); await capture(() => cmdRetries(jsonl, 5));
  section("LONG ASSISTANT TEXTS (PIVOTS)"); await capture(() => cmdPivots(jsonl, 600));
  section("PHASES"); await capture(() => cmdPhases(jsonl, 400));
  section("CANDIDATE SKILL PATTERNS (JSON)"); await capture(() => cmdPatterns(jsonl, null));
  const text = lines.join("\n");
  writeFileSync(outPath, text, "utf8");
  console.log(`wrote ${outPath} (${text.length.toLocaleString()} chars, ~${Math.floor(text.length / 4).toLocaleString()} tokens)`);
}
