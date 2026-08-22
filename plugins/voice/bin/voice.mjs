#!/usr/bin/env node
// voice — mine your own transcripts into an operator profile and per-prompt cues that every session reads.
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

function readTurns(ctx) {
  return fs.readFileSync(ctx.files.turns, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
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
  if (!turns) turns = readTurns(ctx);
  const s = buildSample(turns);
  atomicWrite(ctx.files.sample, s.markdown);
  process.stdout.write(`sample: ${s.count} turns, ${s.words} words -> ${ctx.files.sample}\n`);
  return s.markdown;
}

async function doProfile(ctx, sampleMd, model) {
  const { distil } = await import("../src/distil.mjs");
  if (!sampleMd) sampleMd = fs.readFileSync(ctx.files.sample, "utf8");
  process.stdout.write(`distilling profile with claude -p --model ${model} (one call)...\n`);
  const profile = distil(sampleMd, { model });
  atomicWrite(ctx.files.profile, profile + "\n");
  process.stdout.write(`profile -> ${ctx.files.profile}\n`);
  return profile;
}

async function doCues(ctx, sampleMd, profile, turns, model) {
  const { distilCues, validateCues } = await import("../src/cues.mjs");
  if (!sampleMd) sampleMd = fs.readFileSync(ctx.files.sample, "utf8");
  if (!profile) profile = fs.readFileSync(ctx.files.profile, "utf8");
  if (!turns) turns = readTurns(ctx);
  process.stdout.write(`distilling cues with claude -p --model ${model} (one call)...\n`);
  const raw = distilCues(sampleMd, profile, { model });
  const { kept, dropped } = validateCues(raw, turns);
  atomicWrite(ctx.files.cues, JSON.stringify({ generated: new Date().toISOString(), model, cues: kept, dropped }, null, 2) + "\n");
  for (const c of kept) process.stdout.write(`  ${c.id.padEnd(28)} ${String(c.fires).padStart(5)} fires (${c.rate}%)  ${c.meaning}\n`);
  for (const d of dropped) process.stdout.write(`  dropped ${d.id}: ${d.why}\n`);
  process.stdout.write(`cues -> ${ctx.files.cues} (${kept.length} kept, ${dropped.length} dropped)\n`);
  return kept;
}

(async () => {
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(`voice <command>

  setup              mine + sample + profile + cues (first run; re-run to refresh)  [--model sonnet]
  mine               extract your typed turns from ~/.claude/projects
  sample             build the stratified sample from mined turns
  profile            distil the sample into profile.md via claude -p  [--model sonnet]
  cues               distil the sample + profile into cues.json (per-prompt detectors)  [--model sonnet]
  test [text]        run cues over the mined corpus (fire counts + examples), or over one message
  print-prompt       write the profile distillation prompt to stdout (use any model yourself)
  status             where things are, and what the hooks will do

  env: VOICE_HOME (override dir), VOICE_TRANSCRIPTS (override source), CLAUDE_VOICE=off (disable hooks)
`);
    return;
  }

  const ctx = await getCtx();

  if (cmd === "status") {
    const has = p => fs.existsSync(p) ? `${p} (${fs.statSync(p).size} bytes)` : `${p} (missing)`;
    process.stdout.write(`transcripts: ${ctx.paths.transcriptsDir}\nturns:       ${has(ctx.files.turns)}\nsample:      ${has(ctx.files.sample)}\nprofile:     ${has(ctx.files.profile)}\ncues:        ${has(ctx.files.cues)}\n`);
    process.stdout.write(fs.existsSync(ctx.files.profile) ? "SessionStart hook: injects the profile\n" : "SessionStart hook: silent until `voice setup` writes a profile\n");
    process.stdout.write(fs.existsSync(ctx.files.cues) ? "UserPromptSubmit hook: runs cues.json on every prompt\n" : "UserPromptSubmit hook: silent until `voice setup` writes cues\n");
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
  if (cmd === "cues") { await doCues(ctx, null, null, null, getFlag("--model", args) || "sonnet"); return; }
  if (cmd === "test") {
    const { runCues } = await import("../src/cues.mjs");
    const list = JSON.parse(fs.readFileSync(ctx.files.cues, "utf8")).cues;
    const text = args.slice(1).join(" ");
    if (text) {
      const f = runCues(text, list);
      process.stdout.write(f.length ? f.map(x => `- ${x.id}: ${x.note}`).join("\n") + "\n" : "(no cue fires)\n");
      return;
    }
    const turns = readTurns(ctx).filter(t => t.kind === "typed");
    for (const c of list) {
      const hits = turns.filter(t => runCues(t.text, [c]).length);
      process.stdout.write(`\n## ${c.id} — ${hits.length}/${turns.length}  ${c.meaning}\n   note: ${c.note}\n`);
      for (const h of hits.slice(0, 4)) process.stdout.write(`   > ${h.text.replace(/\s+/g, " ").slice(0, 120)}\n`);
    }
    const fired = turns.filter(t => runCues(t.text, list).length).length;
    process.stdout.write(`\n${fired}/${turns.length} turns fire at least one cue (${Math.round(100 * fired / turns.length)}%)\n`);
    return;
  }
  if (cmd === "setup") {
    const turns = await doMine(ctx);
    const typed = turns.filter(t => t.kind === "typed").length;
    if (typed < 50) {
      process.stderr.write(`only ${typed} typed turns found — too thin to profile. Use more sessions first, or point VOICE_TRANSCRIPTS elsewhere.\n`);
      process.exitCode = 1;
      return;
    }
    const model = getFlag("--model", args) || "sonnet";
    const sampleMd = await doSample(ctx, turns);
    const profile = await doProfile(ctx, sampleMd, model);
    await doCues(ctx, sampleMd, profile, turns, model);
    process.stdout.write('\nread profile.md and cues.json, edit or disable anything wrong ("enabled": false), then start a new session.\n');
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exitCode = 1;
})().catch(e => { process.stderr.write(e.message + "\n"); process.exitCode = 1; });
