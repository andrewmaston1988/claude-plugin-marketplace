import { readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { connectUnified, getClaudeSession, listActiveClaudeSessionsByCwd, getLastCheckpointSize, setLastCheckpointSize, upsertClaudeSession } from "../pipeline-db/index.mjs";

function expandUserPath(path) {
  if (!path || typeof path !== "string") return path;
  if (path.startsWith("~")) {
    return path.replace(/^~/, homedir());
  }
  return path;
}

function readTemplateFile(path) {
  try {
    return readFileSync(expandUserPath(path), "utf-8").trim();
  } catch {
    return null;
  }
}

function normalizePathForMatch(path) {
  if (!path) return "";
  return path.replace(/\\/g, "/").toLowerCase();
}

function resolveSessionId(stdinJson, { fsListSessions, fsReadSession }) {
  if (stdinJson && stdinJson.session_id) {
    return stdinJson.session_id;
  }

  const cwd = normalizePathForMatch(stdinJson?.cwd || process.cwd());
  const sessionsDir = join(homedir(), ".claude", "sessions");

  let matches = [];
  if (fsListSessions && fsReadSession) {
    for (const fileName of fsListSessions(sessionsDir)) {
      const sessionData = fsReadSession(join(sessionsDir, fileName));
      if (sessionData) {
        const sessionCwd = normalizePathForMatch(sessionData.cwd || "");
        if (sessionCwd === cwd && sessionData.sessionId) {
          matches.push({
            updatedAt: sessionData.updatedAt || 0,
            sessionId: sessionData.sessionId,
          });
        }
      }
    }
  } else {
    try {
      if (existsSync(sessionsDir)) {
        const files = require("node:fs").readdirSync(sessionsDir);
        for (const fileName of files) {
          try {
            const filePath = join(sessionsDir, fileName);
            const text = readFileSync(filePath, "utf-8").trim();
            if (text) {
              const d = JSON.parse(text);
              const sessionCwd = normalizePathForMatch(d.cwd || "");
              if (sessionCwd === cwd && d.sessionId) {
                matches.push({
                  updatedAt: d.updatedAt || 0,
                  sessionId: d.sessionId,
                });
              }
            }
          } catch {
            // ignore parse/read errors
          }
        }
      }
    } catch {
      // ignore directory listing errors
    }
  }

  if (matches.length > 0) {
    matches.sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0].sessionId;
  }

  return crypto.randomUUID().replace(/-/g, "");
}

function buildAdditionalContext(params, { fsReadTemplate }) {
  const {
    prevAnyTs = 0,
    now = Date.now() / 1000,
    transcriptSize = 0,
    lastCheckpointSize = 0,
    isKeepalive = false,
    compactMarkerExists = false,
    env = process.env,
    baseContext = "",
  } = params;

  let ctx = baseContext;

  const CHECKPOINT_SIZE_THRESHOLD = 2_000_000;
  const CHECKPOINT_SIZE_GROWTH = 1_000_000;

  if (!isKeepalive && (now - prevAnyTs) >= 240 && !env.CORRELATION_ID) {
    const tick = fsReadTemplate?.("~/.claude/templates/keepalive-tick.md") || readTemplateFile("~/.claude/templates/keepalive-tick.md");
    const init = fsReadTemplate?.("~/.claude/templates/keepalive-init.md") || readTemplateFile("~/.claude/templates/keepalive-init.md");

    if (tick && init) {
      ctx += "\n\n" + init.replace("{tick}", tick);
    }
  }

  if (prevAnyTs === 0 && !isKeepalive) {
    ctx += (
      "\n\n**Scout reminder (one-time):** This machine has a `scout` MCP indexed across all projects (CLAUDE, torrent-hub, scout, nova-*). For any \"find / where is / look for / what calls / how does X work\" intent, use Scout (mcp__scout__*) BEFORE Read/Grep/Glob — it is faster, ranked, and cross-repo. Invoke the `scout` skill for the tool-selection guide."
    );
  }

  let shouldCheckpoint = false;
  if (!isKeepalive && !env.CORRELATION_ID && transcriptSize >= CHECKPOINT_SIZE_THRESHOLD) {
    const lcs = lastCheckpointSize ?? 0;
    if (lcs === 0 || (transcriptSize - lcs) >= CHECKPOINT_SIZE_GROWTH) {
      shouldCheckpoint = true;
    }
  }

  if (shouldCheckpoint) {
    const resume = fsReadTemplate?.("~/.claude/templates/compact-resume.md") || readTemplateFile("~/.claude/templates/compact-resume.md");
    const template = fsReadTemplate?.("~/.claude/templates/session-checkpoint.md") || readTemplateFile("~/.claude/templates/session-checkpoint.md");

    if (resume && template) {
      const sp = join(process.cwd(), "STATE.md");
      const checkpoint = template
        .replace("{n}", `${Math.floor(transcriptSize / 1024)} KB transcript`)
        .replace("{sp}", sp)
        .replace("{resume}", resume);
      ctx = checkpoint;
    }
  }

  if (!isKeepalive && compactMarkerExists) {
    ctx += (
      "\n\n**Compaction just happened.** A skeletal STATE.md was written by the PreCompact backstop. While your post-compact summary is still in context, invoke `/compact+` to write a richer version reflecting the current state of work."
    );
  }

  return ctx;
}

async function main() {
  let stdinJson = {};
  try {
    let data = "";
    for await (const chunk of process.stdin) {
      data += chunk;
    }
    if (data.trim()) {
      stdinJson = JSON.parse(data);
    }
  } catch {
    stdinJson = {};
  }

  const prompt = stdinJson.prompt || "";
  const transcriptPath = stdinJson.transcript_path || "";
  const sessionId = stdinJson.session_id || null;
  const cwd = stdinJson.cwd || process.cwd();
  const isKeepalive = prompt.startsWith("Cache keepalive tick");

  let ctx = "";
  let db = null;

  try {
    const baseContext = readTemplateFile("~/.claude/templates/session-context.md") || "";
    ctx = baseContext;

    db = connectUnified();

    const resolvedSessionId = sessionId || resolveSessionId(stdinJson, {
      fsListSessions: null,
      fsReadSession: null,
    });

    const now = Math.floor(Date.now() / 1000);

    const existingSession = getClaudeSession(db, resolvedSessionId);
    const prevAnyTs = existingSession?.started_at ?? 0;

    upsertClaudeSession(db, {
      sessionId: resolvedSessionId,
      cwd,
      startedAt: now,
      userTs: isKeepalive ? null : now,
      summary: null,
    });

    let transcriptSize = 0;
    if (transcriptPath) {
      try {
        transcriptSize = statSync(transcriptPath).size;
      } catch {
        transcriptSize = 0;
      }
    }

    let lastCheckpointSize = 0;
    try {
      const sizeOrNull = getLastCheckpointSize(db, resolvedSessionId);
      lastCheckpointSize = sizeOrNull ?? 0;
    } catch {
      lastCheckpointSize = 0;
    }

    const compactMarkerPath = join(homedir(), ".claude", ".compact_just_ran");
    const compactMarkerExists = existsSync(compactMarkerPath);

    ctx = buildAdditionalContext(
      {
        prevAnyTs,
        now,
        transcriptSize,
        lastCheckpointSize,
        isKeepalive,
        compactMarkerExists,
        env: process.env,
        baseContext: ctx,
      },
      {
        fsReadTemplate: null,
      }
    );

    if (transcriptSize >= 2_000_000 && !isKeepalive && !process.env.CORRELATION_ID) {
      const lcs = lastCheckpointSize ?? 0;
      if (lcs === 0 || (transcriptSize - lcs) >= 1_000_000) {
        try {
          setLastCheckpointSize(db, resolvedSessionId, transcriptSize);
        } catch {
          // ignore DB update failure for checkpoint size
        }
      }
    }

    if (compactMarkerExists && !isKeepalive) {
      try {
        unlinkSync(compactMarkerPath);
      } catch {
        // ignore unlink errors (ENOENT, permission issues)
      }
    }

    const output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ctx,
      },
    };

    process.stdout.write(JSON.stringify(output) + "\n");
  } catch (err) {
    const logPath = join(homedir(), ".pipeline", "logs", "user-prompt-submit.log");
    try {
      const { appendFileSync } = require("node:fs");
      const isoTimestamp = new Date().toISOString();
      appendFileSync(logPath, `${isoTimestamp} Error: ${err.stack}\n`);
    } catch {
      // ignore logging errors
    }

    const fallbackOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "",
      },
    };
    process.stdout.write(JSON.stringify(fallbackOutput) + "\n");
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

main().catch(() => {
  const fallbackOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "",
    },
  };
  process.stdout.write(JSON.stringify(fallbackOutput) + "\n");
  process.exit(0);
});
