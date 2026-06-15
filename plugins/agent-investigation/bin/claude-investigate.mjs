#!/usr/bin/env node
// claude-investigate — agent transcript investigation CLI. Run --help for usage.

import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { locateAgent } from "../scripts/locate-agent.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const scriptPath = resolve(pluginRoot, "scripts", "transcript_mine.py");

// Get Python executable path (check PIPELINE_PYTHON env var, then fallback to python)
function getPythonPath() {
  if (process.env.PIPELINE_PYTHON) {
    return process.env.PIPELINE_PYTHON;
  }
  // Try 'python' first, then 'python3'
  try {
    execSync("python --version", { stdio: "pipe" });
    return "python";
  } catch {
    return "python3";
  }
}

// Check if Python is available and ≥ 3.9
function checkPython() {
  try {
    const pythonPath = getPythonPath();
    const output = execSync(`${pythonPath} --version`, { encoding: "utf-8" });
    // Parse version from "Python 3.x.x"
    const match = output.match(/Python (\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 3 || (major === 3 && minor >= 9);
    }
    return false;
  } catch {
    return false;
  }
}

// Run subcommand via transcript_mine.py
async function runPythonSubcommand(subcommand, ...args) {
  const pythonPath = getPythonPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [scriptPath, subcommand, ...args], {
      stdio: "inherit",
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      resolve(code || 0);
    });
  });
}

function printHelp() {
  const help = `
claude-investigate — Agent transcript investigation CLI

Usage:
  claude-investigate <subcommand> [args...]

Subcommands:
  locate <agent-id>          Find the path to an agent transcript JSONL
  summary <agent-id>         Print a one-page summary (default)
  errors <agent-id>          List all errors encountered
  retries <agent-id>         Find retried tool calls
  pivots <agent-id>          Find planning/pivot moments
  report <agent-id>          Full investigation report
  doctor                     Check Python ≥3.9 availability
  --help                     Show this help message

Examples:
  claude-investigate summary a3a4e064401835fe3
  claude-investigate errors my-agent-123
  claude-investigate --help

Python Dependency:
  Requires Python ≥3.9 on PATH. Set PIPELINE_PYTHON env var to override.

Run 'claude-investigate doctor' to check prerequisites.
`;
  console.log(help);
}

(async () => {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    setTimeout(() => process.exit(0), 150);
    return;
  }

  const cmd = args[0];

  // Doctor subcommand — check Python availability
  if (cmd === "doctor") {
    if (checkPython()) {
      console.log("✓ Python ≥3.9 found");
      setTimeout(() => process.exit(0), 150);
    } else {
      console.error(
        "✗ Python ≥3.9 not found or not on PATH\n" +
          "  Set PIPELINE_PYTHON=/path/to/python3 and try again"
      );
      setTimeout(() => process.exit(1), 150);
    }
    return;
  }

  // Validate subcommand
  const validSubcommands = [
    "locate",
    "summary",
    "errors",
    "retries",
    "pivots",
    "report",
  ];
  if (!validSubcommands.includes(cmd)) {
    console.error(`Unknown subcommand: ${cmd}`);
    console.error(`Run 'claude-investigate --help' for usage`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  // For locate subcommand, use our mjs implementation (no Python needed)
  if (cmd === "locate") {
    const agentId = args[1];
    if (!agentId) {
      console.error("Usage: claude-investigate locate <agent-id>");
      setTimeout(() => process.exit(1), 150);
      return;
    }

    // Default to current working directory's sessions
    const sessionsDir = process.cwd();
    const result = locateAgent(sessionsDir, agentId);

    if (result) {
      console.log(result);
      setTimeout(() => process.exit(0), 150);
    } else {
      console.error(`No agent transcript found for ID: ${agentId}`);
      setTimeout(() => process.exit(1), 150);
    }
    return;
  }

  // Check Python is available for other subcommands
  if (!checkPython()) {
    console.error(
      "Error: Python ≥3.9 not found or not on PATH\n" +
        "  Set PIPELINE_PYTHON=/path/to/python3 and try again\n" +
        "  Or run: claude-investigate doctor"
    );
    setTimeout(() => process.exit(1), 150);
    return;
  }

  // For other subcommands, delegate to transcript_mine.py
  const agentId = args[1];
  if (!agentId) {
    console.error(`Usage: claude-investigate ${cmd} <agent-id>`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  // Locate the agent first
  const sessionsDir = process.cwd();
  const agentPath = locateAgent(sessionsDir, agentId);
  if (!agentPath) {
    console.error(`No agent transcript found for ID: ${agentId}`);
    setTimeout(() => process.exit(1), 150);
    return;
  }

  // Run the Python subcommand
  try {
    const exitCode = await runPythonSubcommand(cmd, agentPath);
    setTimeout(() => process.exit(exitCode), 150);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    setTimeout(() => process.exit(1), 150);
  }
})().catch((err) => {
  console.error(`Error: ${err.message}`);
  setTimeout(() => process.exit(1), 150);
});
