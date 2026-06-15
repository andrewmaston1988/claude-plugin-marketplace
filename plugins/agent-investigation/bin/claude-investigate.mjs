#!/usr/bin/env node
// claude-investigate — agent transcript investigation CLI. Run --help for usage.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { locateAgentInProject } from "../scripts/locate-agent.mjs";
import {
  cmdSessions, cmdTools, cmdNgrams, cmdRetries, cmdErrors,
  cmdScope, cmdFindings, cmdPivots, cmdSlice, cmdSummary,
  cmdAgents, cmdSkills, cmdPhases, cmdCompare, cmdPatterns,
  cmdSample, cmdReport,
} from "../scripts/transcript-mine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);

function getFlag(name, args) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function getFlagInt(name, args, def) {
  const v = getFlag(name, args);
  return v !== undefined ? parseInt(v, 10) : def;
}

function hasFlag(name, args) {
  return args.includes(name);
}

function printHelp() {
  console.log(`
claude-investigate — Agent transcript investigation CLI

Usage:
  claude-investigate <subcommand> [args...]

Subcommands (agent-id based — auto-locates the JSONL):
  locate   <agent-id>                     Print path to agent's JSONL
  summary  <agent-id>                     One-page summary
  errors   <agent-id>                     All errored tool calls
  retries  <agent-id> [--window N]        Retried tool calls (default window=5)
  pivots   <agent-id> [--min-text-chars N] Long assistant texts (default 600)
  report   <agent-id> [--out FILE]        Full investigation report
  tools    <agent-id> [--top N]           Tool frequency table
  ngrams   <agent-id> [--n N] [--top N]  Tool N-gram patterns
  agents   <agent-id>                     Agent tool dispatches
  skills   <agent-id>                     Skill invocations
  phases   <agent-id> [--text-threshold N] Phase segmentation
  sample   <agent-id> [--n N]             Uniform-stride sample
  scope    <agent-id> --worktree <path>   File scope audit

Subcommands (file-path based):
  sessions <dir>                          List all session JSONLs in dir
  findings <a.jsonl> <b.jsonl>           Contrastive findings analysis
  compare  <a.jsonl> <b.jsonl>           Tool-trajectory diff
  patterns <jsonl> [--out FILE]          Candidate skill patterns (JSON)
  slice    <jsonl> --turn N [--ctx N]    Extract turn ± context

  doctor                                  Check dependencies
  --help                                  Show this help

Examples:
  claude-investigate summary a3a4e064401835fe3
  claude-investigate errors my-agent-123
  claude-investigate sessions ~/.claude/projects/my-project/sessions
`);
}

(async () => {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    setTimeout(() => process.exit(0), 150);
    return;
  }

  const cmd = args[0];

  if (cmd === "doctor") {
    console.log("✓ Node.js " + process.version + " (no external dependencies required)");
    setTimeout(() => process.exit(0), 150);
    return;
  }

  // File-path based subcommands — no agent-id lookup needed
  if (cmd === "sessions") {
    const dir = args[1];
    if (!dir) { console.error("Usage: claude-investigate sessions <dir>"); setTimeout(() => process.exit(1), 150); return; }
    await cmdSessions(dir);
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "findings") {
    const [a, b] = [args[1], args[2]];
    if (!a || !b) { console.error("Usage: claude-investigate findings <a.jsonl> <b.jsonl>"); setTimeout(() => process.exit(1), 150); return; }
    cmdFindings(a, b);
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "compare") {
    const [a, b] = [args[1], args[2]];
    if (!a || !b) { console.error("Usage: claude-investigate compare <a.jsonl> <b.jsonl>"); setTimeout(() => process.exit(1), 150); return; }
    await cmdCompare(a, b);
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "patterns") {
    const jsonl = args[1];
    if (!jsonl) { console.error("Usage: claude-investigate patterns <jsonl> [--out FILE]"); setTimeout(() => process.exit(1), 150); return; }
    await cmdPatterns(jsonl, getFlag("--out", args) || null);
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (cmd === "slice") {
    const jsonl = args[1];
    const turn = getFlagInt("--turn", args, null);
    if (!jsonl || turn === null) { console.error("Usage: claude-investigate slice <jsonl> --turn N [--ctx N]"); setTimeout(() => process.exit(1), 150); return; }
    await cmdSlice(jsonl, turn, getFlagInt("--ctx", args, 2));
    setTimeout(() => process.exit(0), 150);
    return;
  }

  // Agent-id based subcommands
  const validSubcommands = ["locate", "summary", "errors", "retries", "pivots", "report", "tools", "ngrams", "agents", "skills", "phases", "sample", "scope"];
  if (!validSubcommands.includes(cmd)) {
    console.error(`Unknown subcommand: ${cmd}\nRun 'claude-investigate --help' for usage`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  const agentId = args[1];
  if (!agentId) {
    console.error(`Usage: claude-investigate ${cmd} <agent-id>`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  if (cmd === "locate") {
    const result = locateAgentInProject(agentId);
    if (result) { console.log(result); setTimeout(() => process.exit(0), 150); }
    else { console.error(`No agent transcript found for ID: ${agentId}`); setTimeout(() => process.exit(1), 150); }
    return;
  }

  const agentPath = locateAgentInProject(agentId);
  if (!agentPath) {
    console.error(`No agent transcript found for ID: ${agentId}`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  try {
    if (cmd === "summary") await cmdSummary(agentPath);
    else if (cmd === "errors") await cmdErrors(agentPath);
    else if (cmd === "retries") await cmdRetries(agentPath, getFlagInt("--window", args, 5));
    else if (cmd === "pivots") await cmdPivots(agentPath, getFlagInt("--min-text-chars", args, 600));
    else if (cmd === "report") await cmdReport(agentPath, getFlag("--out", args) || null);
    else if (cmd === "tools") await cmdTools(agentPath, getFlagInt("--top", args, 15));
    else if (cmd === "ngrams") await cmdNgrams(agentPath, getFlagInt("--n", args, 3), getFlagInt("--top", args, 15));
    else if (cmd === "agents") await cmdAgents(agentPath);
    else if (cmd === "skills") await cmdSkills(agentPath);
    else if (cmd === "phases") await cmdPhases(agentPath, getFlagInt("--text-threshold", args, 400));
    else if (cmd === "sample") await cmdSample(agentPath, getFlagInt("--n", args, 20));
    else if (cmd === "scope") {
      const worktree = getFlag("--worktree", args);
      if (!worktree) { console.error("scope requires --worktree <path>"); setTimeout(() => process.exit(1), 150); return; }
      const allow = args.filter((a, i) => i > 0 && args[i - 1] === "--allow");
      await cmdScope(agentPath, worktree, allow);
    }
    setTimeout(() => process.exit(0), 150);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    setTimeout(() => process.exit(1), 150);
  }
})().catch(err => {
  console.error(`Error: ${err.message}`);
  setTimeout(() => process.exit(1), 150);
});
