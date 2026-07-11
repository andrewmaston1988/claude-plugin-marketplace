#!/usr/bin/env node
// UserPromptSubmit hook: inject a per-model discipline delta.
//
// Reads the hook payload from stdin, detects the running model, and if a
// matching delta file exists in <plugin>/disciplines/, emits it wrapped in a
// <discipline-pack> marker (UserPromptSubmit stdout is added as context).
//
// Invariants:
// - NEVER blocks a prompt: every failure path exits 0 with no output.
// - CLAUDE_DISCIPLINE=off disables injection (A/B control arm).
// - No delta file for the model => no output (unlisted models run clean).
//
// The <discipline-pack> wrapper is load-bearing: the grader strips it for
// blind adjudication; the scanner reads it to detect a session's arm.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ordered [substring, filename] pairs matched against the full model ID.
// First match wins. Substrings chosen so version families don't collide
// (e.g. "sonnet-5" does not match "claude-sonnet-4-5").
const FAMILY_FILES = [
  ['sonnet-5', 'sonnet-5.md'],
  ['opus-4-8', 'opus-4-8.md'],
];

// settings.json model aliases -> representative full IDs, for the first
// prompt of a session (no assistant turn in the transcript yet).
const ALIAS_IDS = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

const MAX_TRANSCRIPT_SCAN_LINES = 400; // newest-first; model is on every assistant line

const DISCIPLINES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'disciplines',
);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function modelFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n');
  } catch {
    return null;
  }
  const tail = lines.slice(-MAX_TRANSCRIPT_SCAN_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.type !== 'assistant') continue;
    const model = evt?.message?.model;
    if (model) return String(model);
  }
  return null;
}

function modelFromSettings() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const alias = String(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).model || '');
    if (!alias) return null;
    if (alias.startsWith('claude-')) return alias;
    return ALIAS_IDS[alias.toLowerCase()] || null;
  } catch {
    return null;
  }
}

function deltaPathFor(model) {
  for (const [substring, filename] of FAMILY_FILES) {
    if (model.includes(substring)) {
      const p = path.join(DISCIPLINES_DIR, filename);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function main() {
  if ((process.env.CLAUDE_DISCIPLINE || '').toLowerCase() === 'off') return;
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return;
  }
  const prompt = String(payload?.prompt || '');
  if (prompt.startsWith('Cache keepalive tick')) return; // don't stack pack text on tick turns
  const model = modelFromTranscript(payload?.transcript_path) || modelFromSettings();
  if (!model) return;
  const deltaPath = deltaPathFor(model);
  if (!deltaPath) return;
  let delta;
  try {
    delta = fs.readFileSync(deltaPath, 'utf-8').trim();
  } catch {
    return;
  }
  if (!delta) return;
  process.stdout.write(`<discipline-pack model="${model}" v="1">\n${delta}\n</discipline-pack>\n`);
}

try {
  main();
} catch {
  // a broken hook must never block a prompt
}
process.exit(0);
