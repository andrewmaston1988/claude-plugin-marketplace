#!/usr/bin/env node
// voice — mine your own transcripts into an operator profile that every new session reads first.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(name, list) {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}

function atomicWrite(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", body);
  fs.renameSync(p + ".tmp", p);
}

async function getCtx() {
  const { getPaths, filesFor } = await import("../src/paths.mjs");
  const paths = getPaths();
  return { paths, files: filesFor(paths) };
}

async function doMine(ctx) {
  const { mine } = await import("../src/mine.mjs");
  const { turns, stats } = await mine({ transcriptsDir: ctx.paths.transcriptsDir, outFile: ctx.files.turns });
  atomicWrite(ctx.files.stats, JSON.stringify(stats, null, 2));
  process.stdout.write(`mined ${stats.kept} turns from ${stats.files} transcripts (${stats.typedWords.total} typed words, median ${stats.typedWords.p50}) -> ${ctx.files.turns}\n`);
  return turns;
}

async function doSample(ctx, turns) {
  const { buildSample } = await import("../src/sample.mjs");
  if (!turns) turns = fs.readFileSync(ctx.files.turns, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  const s = buildSample(turns);
  atomicWrite(ctx.files.sample, s.markdown);
  process.stdout.write(`sample: ${s.count} turns, ${s.words} words -> ${ctx.files.sample}\n`);
  return s.markdown;
}

async function doProfile(ctx, sampleMd, model) {
  const { distil } = await import("../src/distil.mjs");
  if (!sampleMd) sampleMd = fs.readFileSync(ctx.files.sample, "utf8");
  process.stdout.write(`distilling with claude -p --model ${model} (one call)...\n`);
  const profile = distil(sampleMd, { model });
  atomicWrite(ctx.files.profile, profile + "\n");
  process.stdout.write(`profile -> ${ctx.files.profile}\n`);
  return profile;
}

(async () => {
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(`voice <command>

  setup              mine + sample + profile (first run; re-run to refresh)
  mine               extract your typed turns from ~/.claude/projects
  sample             build the stratified sample from mined turns
  profile            distil the sample into profile.md via claude -p  [--model sonnet]
  print-prompt       write the distillation prompt to stdout (use any model yourself)
  status             where things are, and whether a profile is installed

  env: VOICE_HOME (override dir), VOICE_TRANSCRIPTS (override source), CLAUDE_VOICE=off (disable hook)
`);
    return;
  }

  const ctx = await getCtx();

  if (cmd === "status") {
    const has = p => fs.existsSync(p) ? `${p} (${fs.statSync(p).size} bytes)` : `${p} (missing)`;
    process.stdout.write(`transcripts: ${ctx.paths.transcriptsDir}\nturns:       ${has(ctx.files.turns)}\nsample:      ${has(ctx.files.sample)}\nprofile:     ${has(ctx.files.profile)}\n`);
    process.stdout.write(fs.existsSync(ctx.files.profile) ? "hook: will inject the profile at SessionStart\n" : "hook: silent until `voice setup` writes a profile\n");
    return;
  }
  if (cmd === "mine") { await doMine(ctx); return; }
  if (cmd === "sample") { await doSample(ctx); return; }
  if (cmd === "print-prompt") {
    const { buildPrompt } = await import("../src/distil.mjs");
    process.stdout.write(buildPrompt(fs.readFileSync(ctx.files.sample, "utf8")));
    return;
  }
  if (cmd === "profile") { await doProfile(ctx, null, getFlag("--model", args) || "sonnet"); return; }
  if (cmd === "setup") {
    const turns = await doMine(ctx);
    const typed = turns.filter(t => t.kind === "typed").length;
    if (typed < 50) {
      process.stderr.write(`only ${typed} typed turns found — too thin to profile. Use more sessions first, or point VOICE_TRANSCRIPTS elsewhere.\n`);
      process.exitCode = 1;
      return;
    }
    const sampleMd = await doSample(ctx, turns);
    await doProfile(ctx, sampleMd, getFlag("--model", args) || "sonnet");
    process.stdout.write("\nread the profile, edit anything wrong, then start a new session — the SessionStart hook injects it.\n");
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exitCode = 1;
})().catch(e => { process.stderr.write(e.message + "\n"); process.exitCode = 1; });
