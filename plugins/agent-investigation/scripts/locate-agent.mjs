import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Locate an agent transcript JSONL by ID.
 *
 * Search strategy:
 * 1. Standard subagent: agent-<id>.jsonl in sessionsDir
 * 2. Workflow subagent: subagents/workflows/<wf-id>/agent-<id>.jsonl
 * 3. Prefix match: if agentId is < 6 chars, find first agent-<id>* or agent-*<id>*
 *
 * @param {string} sessionsDir - Base sessions directory (e.g., claude-plugin-marketplace/sessions/)
 * @param {string} agentId - Full or partial agent ID
 * @returns {string|null} - Absolute path to agent-<id>.jsonl, or null if not found
 */
export function locateAgent(sessionsDir, agentId) {
  if (!agentId || agentId.trim().length === 0) {
    return null;
  }

  const trimmedId = agentId.trim();

  // 1. Try standard subagent path
  const standardPath = join(sessionsDir, `agent-${trimmedId}.jsonl`);
  try {
    if (statSync(standardPath).isFile()) {
      return standardPath;
    }
  } catch {
    // File doesn't exist, continue
  }

  // 2. Try workflow subagent paths — search subagents/workflows/
  const workflowsBase = join(sessionsDir, "subagents", "workflows");
  try {
    const wfDirs = readdirSync(workflowsBase, { withFileTypes: true });
    for (const wfDir of wfDirs) {
      if (!wfDir.isDirectory()) continue;
      const agentPath = join(wfDir.parentPath, wfDir.name, `agent-${trimmedId}.jsonl`);
      try {
        if (statSync(agentPath).isFile()) {
          return agentPath;
        }
      } catch {
        // File doesn't exist, continue to next
      }
    }
  } catch {
    // workflows dir doesn't exist, continue
  }

  // 3. Prefix match (if agentId is short)
  if (trimmedId.length < 6) {
    // Try matching agent-*<id>.jsonl in sessionsDir
    try {
      const files = readdirSync(sessionsDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        if (file.name.startsWith("agent-") && file.name.endsWith(".jsonl")) {
          if (file.name.includes(trimmedId)) {
            return join(sessionsDir, file.name);
          }
        }
      }
    } catch {
      // Can't read sessionsDir
    }

    // Try workflow agents with prefix match
    try {
      const wfDirs = readdirSync(workflowsBase, { withFileTypes: true });
      for (const wfDir of wfDirs) {
        if (!wfDir.isDirectory()) continue;
        try {
          const agentFiles = readdirSync(
            join(wfDir.parentPath, wfDir.name),
            { withFileTypes: true }
          );
          for (const file of agentFiles) {
            if (!file.isFile()) continue;
            if (file.name.startsWith("agent-") && file.name.endsWith(".jsonl")) {
              if (file.name.includes(trimmedId)) {
                return join(wfDir.parentPath, wfDir.name, file.name);
              }
            }
          }
        } catch {
          // Can't read this workflow dir
        }
      }
    } catch {
      // workflows dir doesn't exist
    }
  }

  return null;
}

export default { locateAgent };
