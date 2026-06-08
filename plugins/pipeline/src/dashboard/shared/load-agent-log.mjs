// Tail the most-recent assistant entries from the Claude Code session JSONL
// for `projectRoot`. Discovery rules:
//   - find ~/.claude/projects/<encoded-path>/*.jsonl
//   - prefer the file whose ctime ≥ earliest session start - 2min
//   - reverse-walk, parse assistant messages, extract first text or
//     tool_use block from each, stop after N entries.
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Encoding rule Claude Code uses for project paths: replace : / \ with -.
function _encodePath(p) {
  return String(p).replace(/[:\\/]/g, "-");
}

function _findJsonl(sessions, projectRoot) {
  const baseSlug = _encodePath(projectRoot);
  const projectsRoot = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) return null;
  let convDirs;
  try {
    convDirs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith(baseSlug))
      .map(d => join(projectsRoot, d.name));
  } catch { return null; }
  if (convDirs.length === 0) return null;

  const allFiles = [];
  for (const d of convDirs) {
    let files;
    try { files = readdirSync(d); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(d, f);
      let st;
      try { st = statSync(path); } catch { continue; }
      allFiles.push({ path, mtime: st.mtimeMs, ctime: st.ctimeMs });
    }
  }
  if (allFiles.length === 0) return null;
  allFiles.sort((a, b) => b.mtime - a.mtime);

  // Prefer files whose ctime is at-or-after the earliest session start - 2min.
  if (sessions && sessions.length) {
    const earliest = Math.min(...sessions
      .map(s => Date.parse(s.spawn_time))
      .filter(t => !isNaN(t))
    );
    if (Number.isFinite(earliest)) {
      const cutoff = earliest - 2 * 60_000;
      const candidates = allFiles.filter(f => f.ctime >= cutoff);
      if (candidates.length) return candidates[0].path;
    }
  }
  return allFiles[0].path;
}

function _toolLabel(name, inp) {
  if (!inp || typeof inp !== "object") return "";
  if (name === "Bash") return (inp.command || "").slice(0, 80);
  if (name === "Read" || name === "Write" || name === "Edit") return inp.file_path || "";
  if (name === "Glob" || name === "Grep") return inp.pattern || "";
  try { return JSON.stringify(inp).slice(0, 60); } catch { return ""; }
}

export function loadAgentLog(sessions, projectRoot, { limit = 20 } = {}) {
  if (!projectRoot) return [];
  const jsonl = _findJsonl(sessions, projectRoot);
  if (!jsonl) return [];
  let raw;
  try { raw = readFileSync(jsonl, "utf8").split("\n"); } catch { return []; }

  const entries = [];
  for (let i = raw.length - 1; i >= 0 && entries.length < limit; i--) {
    const line = raw[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message;
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text") {
        const text = String(block.text || "").trim().replace(/\n/g, " ");
        if (text) { entries.push({ kind: "msg", text }); break; }
      } else if (block?.type === "tool_use") {
        const name = block.name || "?";
        entries.push({ kind: "tool", name, label: _toolLabel(name, block.input) });
        break;
      }
    }
  }
  return entries.reverse();
}
