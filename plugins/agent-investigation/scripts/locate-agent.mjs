import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getClaudeProjectsDir, getProjectSlug } from "../src/paths.mjs";

// Search a single session's subagents/ dir. Layout:
//   <subagentsDir>/agent-<id>.jsonl                    (standard subagent)
//   <subagentsDir>/workflows/<wf-id>/agent-<id>.jsonl  (workflow subagent)
// Short IDs (< 6 chars) fall back to a substring match.
export function locateAgent(subagentsDir, agentId) {
  if (!agentId || agentId.trim().length === 0) {
    return null;
  }

  const trimmedId = agentId.trim();

  // 1. Standard subagent path
  const standardPath = join(subagentsDir, `agent-${trimmedId}.jsonl`);
  try {
    if (statSync(standardPath).isFile()) {
      return standardPath;
    }
  } catch {
    // File doesn't exist, continue
  }

  // 2. Workflow subagent paths — search workflows/<wf>/
  const workflowsBase = join(subagentsDir, "workflows");
  try {
    const wfDirs = readdirSync(workflowsBase, { withFileTypes: true });
    for (const wfDir of wfDirs) {
      if (!wfDir.isDirectory()) continue;
      const agentPath = join(workflowsBase, wfDir.name, `agent-${trimmedId}.jsonl`);
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
    try {
      const files = readdirSync(subagentsDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        if (file.name.startsWith("agent-") && file.name.endsWith(".jsonl")) {
          if (file.name.includes(trimmedId)) {
            return join(subagentsDir, file.name);
          }
        }
      }
    } catch {
      // Can't read subagentsDir
    }

    try {
      const wfDirs = readdirSync(workflowsBase, { withFileTypes: true });
      for (const wfDir of wfDirs) {
        if (!wfDir.isDirectory()) continue;
        try {
          const agentFiles = readdirSync(
            join(workflowsBase, wfDir.name),
            { withFileTypes: true }
          );
          for (const file of agentFiles) {
            if (!file.isFile()) continue;
            if (file.name.startsWith("agent-") && file.name.endsWith(".jsonl")) {
              if (file.name.includes(trimmedId)) {
                return join(workflowsBase, wfDir.name, file.name);
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

// Resolve an agent transcript for the current project: derive the slug from cwd,
// then search every session's subagents/ dir under ~/.claude/projects/<slug>/.
export function locateAgentInProject(
  agentId,
  cwd = process.cwd(),
  projectsDir = getClaudeProjectsDir()
) {
  const projectDir = join(projectsDir, getProjectSlug(cwd));
  let sessions;
  try {
    sessions = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const match = locateAgent(join(projectDir, session.name, "subagents"), agentId);
    if (match) return match;
  }
  return null;
}

export default { locateAgent, locateAgentInProject };
