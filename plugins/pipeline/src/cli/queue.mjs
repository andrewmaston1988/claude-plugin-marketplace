import { existsSync, readFileSync } from "node:fs";
import { join, basename, isAbsolute, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { close, rowGet, rowAdd, rowUpdate } from "../../scripts/pipeline-db/index.mjs";
import { getFlag, detectDefaultBranch } from "./helpers.mjs";
import { lookupProjectOrFail } from "./project-lookup.mjs";

const QUEUE_STOP_WORDS = new Set([
  "a","an","the","for","in","on","at","to","of","and","or","but",
  "is","are","be","with","into","as","by","from","that","this","it","its",
]);

function queueNameDerive(brief) {
  const lowered = brief.toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9 ]/g, "");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const filtered = words.filter(w => !QUEUE_STOP_WORDS.has(w));
  const candidates = (filtered.length ? filtered : words.slice(0, 1));
  let result = candidates.join("-");
  if (result.length <= 30) return result;
  const parts = result.split("-");
  while (parts.length > 1) {
    parts.pop();
    const cand = parts.join("-");
    if (cand.length <= 30) return cand;
  }
  return parts[0].slice(0, 30);
}

function queueBranchExtract(planFilePath) {
  try {
    const content = readFileSync(planFilePath, "utf8");
    const m = content.match(/\*Branch:\*?\s*`?(autonomous\/[\w-]+|interactive\/[\w-]+)`?/);
    return m ? m[1] : "";
  } catch { return ""; }
}

function queueDepsExtract(planFilePath) {
  let content;
  try { content = readFileSync(planFilePath, "utf8"); } catch { return ""; }
  const lines = content.split("\n");
  const blockLines = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (/\bprerequisites\b\s*:/i.test(lines[i])) {
      blockLines.push(lines[i]);
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) break;
        blockLines.push(lines[j]);
      }
      break;
    }
    if (/^#+\s*prerequisites\s*$/i.test(stripped)) {
      for (let j = i + 1; j < lines.length; j++) {
        const cs = lines[j].trim();
        if (cs.startsWith("#")) break;
        if (cs) blockLines.push(lines[j]);
        else if (blockLines.length) break;
      }
      break;
    }
  }
  if (!blockLines.length) return "";

  const blockText = blockLines.join(" ");
  let slugs = [];

  slugs = [...blockText.matchAll(/`autonomous\/([a-z0-9][a-z0-9-]*)`/gi)].map(m => m[1]);
  if (!slugs.length) {
    slugs = [...blockText.matchAll(/\*{1,2}([a-z0-9][a-z0-9-]+-[a-z0-9][a-z0-9-]*)\*{1,2}/gi)]
      .map(m => m[1]);
  }
  if (!slugs.length) {
    slugs = [...blockText.matchAll(/`([a-z0-9][a-z0-9-]+-[a-z0-9][a-z0-9-]*)`/gi)]
      .map(m => m[1]);
  }
  if (!slugs.length) {
    for (const bl of blockLines) {
      const m = bl.trim().match(/^[-*]\s+([a-z0-9][a-z0-9-]+-[a-z0-9][a-z0-9-]*)/i);
      if (m) slugs.push(m[1]);
    }
  }

  if (!slugs.length) {
    process.stderr.write(
      `WARN: queue-deps-extract: Prerequisites block detected in ${basename(planFilePath)} ` +
      "but no plan slugs could be parsed -- check the plan's formatting or pass --depends manually.\n"
    );
    return "";
  }

  return [...new Set(slugs)].join(",");
}


function queueTargetExtract(planFilePath) {
  try {
    const lines = readFileSync(planFilePath, "utf8").split("\n");
    for (const line of lines) {
      const s = line.trim();
      if (s.startsWith("*Target-Branch:") || s.startsWith("* Target-Branch:")) {
        let value = s.split(":").slice(1).join(":").trim();
        while (value && (value[0] === "*" || value[0] === " ")) value = value.slice(1);
        while (value && (value[value.length - 1] === "*" || value[value.length - 1] === " ")) {
          value = value.slice(0, -1);
        }
        return value || detectDefaultBranch(process.cwd());
      }
    }
  } catch {}
  return detectDefaultBranch(process.cwd());
}

function validateTargetBranch(value) {
  const r = spawnSync("git", ["check-ref-format", "--branch", value],
    { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status === 0) return [true, ""];
  if (r.error) {
    if (value.includes(" ") || value.endsWith(".lock")) {
      return [false, `invalid git branch name: ${value}`];
    }
    return [true, ""];
  }
  return [false, `invalid git branch name: ${value}`];
}

function lintTargetBranchProse(planPath) {
  let content;
  try { content = readFileSync(planPath, "utf8"); } catch { return [true, ""]; }
  if (/^\*\s*Target-Branch:\s*/m.test(content)) return [true, ""];

  const lines = content.split("\n");
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "" || lines[i].startsWith("## ")) { bodyStart = i; break; }
  }
  const body = lines.slice(bodyStart).join("\n");

  if (body.includes("feature/")) {
    for (let i = bodyStart; i < lines.length; i++) {
      if (lines[i].includes("feature/")) {
        return [false,
          `ERROR: plan body mentions 'feature/' branch but no *Target-Branch: annotation found.\n` +
          `Detected at line ${i + 1}: ${lines[i].trim()}\n\n` +
          `Either:\n  - Add \`*Target-Branch: <branch-name>\` immediately under the plan title, OR\n` +
          `  - Pass --target-branch main explicitly to confirm the default.`];
      }
    }
  }
  const trgPat = /target.{0,5}branch/i;
  if (trgPat.test(body)) {
    for (let i = bodyStart; i < lines.length; i++) {
      if (trgPat.test(lines[i])) {
        return [false,
          `ERROR: plan body mentions 'target branch' but no *Target-Branch: annotation found.\n` +
          `Detected at line ${i + 1}: ${lines[i].trim()}\n\n` +
          `Either:\n  - Add \`*Target-Branch: <branch-name>\` immediately under the plan title, OR\n` +
          `  - Pass --target-branch main explicitly to confirm the default.`];
      }
    }
  }
  return [true, ""];
}

export async function run(cmd, argv) {

  if (cmd === "queue-name-derive") {
    const brief = argv.join(" ");
    if (!brief) { process.stderr.write("usage: queue-name-derive <brief>\n"); return 1; }
    process.stdout.write(`name=${queueNameDerive(brief)}\n`);
    return 0;
  }

  if (cmd === "queue-branch-extract") {
    const [planFile] = argv;
    if (!planFile) { process.stderr.write("usage: queue-branch-extract <plan-file>\n"); return 1; }
    process.stdout.write(`branch=${queueBranchExtract(planFile)}\n`);
    return 0;
  }

  if (cmd === "queue-deps-extract") {
    const [planFile] = argv;
    if (!planFile) { process.stderr.write("usage: queue-deps-extract <plan-file>\n"); return 1; }
    process.stdout.write(`depends=${queueDepsExtract(planFile)}\n`);
    return 0;
  }

  if (cmd === "queue-target-extract") {
    const [planFile] = argv;
    if (!planFile) { process.stderr.write("usage: queue-target-extract <plan-file>\n"); return 1; }
    process.stdout.write(`target=${queueTargetExtract(planFile)}\n`);
    return 0;
  }

  if (cmd === "queue-plan") {
    const [project, planFileArg, ...flags] = argv;
    if (!project || !planFileArg) {
      process.stderr.write(
        "usage: queue-plan <project> <plan-file-path> [--branch <name>] " +
        "[--depends <slug,...>] [--target-branch <name>] [--type dev|research|review|test] " +
        "[--r-model] [--d-model] [--q-model] [--rvw-model]\n" +
        "  plan-file-path is the absolute or cwd-relative path to a markdown file.\n" +
        "  Falls back to plan-content extraction when --branch / --depends / --target-branch are absent.\n"
      );
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;

    const stype       = getFlag("--type", flags) || "dev";
    const rModel      = getFlag("--r-model", flags) || "—";
    const dModel      = getFlag("--d-model", flags) || "—";
    const qModel      = getFlag("--q-model", flags) || "—";
    const rvwModel    = getFlag("--rvw-model", flags) || "—";
    let targetBranch  = getFlag("--target-branch", flags) || null;
    const branchFlag  = getFlag("--branch", flags) || null;
    const dependsFlag = getFlag("--depends", flags) || null;

    // Resolve plan path. Three modes:
    //   1. Absolute path → use as-is.
    //   2. Path with separator (`/` or `\`) → resolve relative to cwd.
    //   3. Bare filename (no separator) → resolve under `<projectRoot>/plans/`
    //      (legacy convention; `/plan` skill writes there).
    // The resolved absolute path is what gets stored on the row so downstream
    // consumers (session-gen, merge) don't re-resolve.
    const looksLikePath = planFileArg.includes("/") || planFileArg.includes("\\");
    let planPath;
    if (isAbsolute(planFileArg)) planPath = planFileArg;
    else if (looksLikePath)      planPath = resolve(process.cwd(), planFileArg);
    else                         planPath = join(ctx.projectRoot, "plans", planFileArg);
    if (!planPath.endsWith(".md")) planPath += ".md";

    if (!existsSync(planPath)) {
      close(ctx.db);
      process.stderr.write(`not found: ${planPath}\n`);
      return 1;
    }

    const planText = readFileSync(planPath, "utf8");
    if (planText.includes("*Manual-Only: true*")) {
      close(ctx.db);
      process.stderr.write(
        `REFUSED: ${basename(planPath)} is marked Manual-Only — must be worked by hand, not queued for autonomous sessions.\n`
      );
      return 1;
    }

    const feature = basename(planPath, ".md");
    const plansDir = dirname(planPath);

    // CLI flag wins; fall back to plan-content extraction if a flag is absent.
    let branch  = branchFlag  ?? queueBranchExtract(planPath);
    let depends = dependsFlag ?? queueDepsExtract(planPath);

    if (targetBranch === null) {
      const [ok, msg] = lintTargetBranchProse(planPath);
      if (!ok) { close(ctx.db); process.stderr.write(msg + "\n"); return 1; }
      targetBranch = queueTargetExtract(planPath);
    }

    const [valid, errMsg] = validateTargetBranch(targetBranch);
    if (!valid) {
      close(ctx.db);
      process.stderr.write(`ERROR: invalid target-branch '${targetBranch}': ${errMsg}\n`);
      return 1;
    }

    const derivedSource = branch || `autonomous/${feature}`;
    if (targetBranch === derivedSource || targetBranch.startsWith("autonomous/")) {
      const defaultBranch = detectDefaultBranch(ctx.projectRoot);
      process.stderr.write(
        `WARNING: *Target-Branch: ${targetBranch}* equals the source branch — treating merge destination as '${defaultBranch}'. ` +
        `Use *Branch: \`${targetBranch}\`* for source-branch declaration; reserve *Target-Branch:* for non-default merge destinations only.\n`
      );
      if (!branch) branch = targetBranch;
      targetBranch = defaultBranch;
    }

    if (depends) {
      const completeDir = join(plansDir, "complete");
      const missing = [];
      const validated = [];
      for (const slug of depends.split(",").map(s => s.trim()).filter(Boolean)) {
        const inActive   = existsSync(join(plansDir, slug + ".md"));
        const inComplete = existsSync(join(completeDir, slug + ".md"));
        if (inActive || inComplete) validated.push(slug);
        else missing.push(slug);
      }
      if (missing.length) {
        close(ctx.db);
        process.stderr.write(
          `ERROR: queue-plan: declared prerequisite plan(s) not found under ${plansDir} or ${completeDir}: ` +
          `${missing.join(", ")} -- fix the plan or pass --depends manually.\n`
        );
        return 1;
      }
      depends = validated.join(",");
    }

    try {
      const existing = rowGet(ctx.db, ctx.project, feature);
      const existingStage = existing ? existing.stage : null;

      if (["dev", "test", "manual", "merge", "queued"].includes(existingStage)) {
        process.stderr.write(
          `already at stage '${existingStage}': feature '${feature}' -- manual intervention required before re-queue\n`
        );
        return 1;
      }

      const notes      = `type=${stype}`;
      const branchArg  = branch || "—";
      const dependsArg = depends || null;

      if (existingStage === null) {
        rowAdd(ctx.db, ctx.project, {
          feature, planFile: planPath, stage: "queued", branch: branchArg,
          rModel: rModel !== "—" ? rModel : null,
          dModel: dModel !== "—" ? dModel : null,
          qModel: qModel !== "—" ? qModel : null,
          rvwModel: rvwModel !== "—" ? rvwModel : null,
          dependsOn: dependsArg, targetBranch,
        });
        if (notes) rowUpdate(ctx.db, ctx.project, feature, { notes_extra: notes });
        const brNote = branch ? `, branch=${branch}` : "";
        const depNote = depends ? `, depends_on=${depends}` : "";
        process.stdout.write(`OK: '${feature}' queued (added)${brNote}${depNote}\n`);
      } else {
        const fields = {
          stage: "queued", notes_extra: notes,
          branch: branchArg, depends_on: dependsArg, target_branch: targetBranch,
        };
        if (rModel !== "—") fields.r_model = rModel;
        if (dModel !== "—") fields.d_model = dModel;
        if (qModel !== "—") fields.q_model = qModel;
        if (rvwModel !== "—") fields.rvw_model = rvwModel;
        rowUpdate(ctx.db, ctx.project, feature, fields);
        const brNote = branch ? `, branch=${branch}` : "";
        const depNote = depends ? `, depends_on=${depends}` : "";
        process.stdout.write(`OK: '${feature}' queued (promoted from '${existingStage}')${brNote}${depNote}\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`error: row-add/stage-set failed for '${feature}': ${e.message}\n`);
      return 1;
    } finally { close(ctx.db); }
  }

  if (cmd === "queue-mode-detect") {
    const [plansDir, ...argParts] = argv;
    const arguments_ = argParts.join(" ");
    if (!plansDir || !arguments_) {
      process.stderr.write("usage: queue-mode-detect <plans-dir> <arguments>\n");
      return 1;
    }
    const words = arguments_.trim().split(/\s+/);
    const first = words[0];
    const hasSpaces = arguments_.trim().includes(" ");
    const fname = first.endsWith(".md") ? first : first + ".md";
    const planPath = join(plansDir, fname);

    if (!hasSpaces || existsSync(planPath)) {
      let stype = "dev";
      if (words.length > 1 && ["dev", "research", "test"].includes(words[1])) stype = words[1];
      if (!existsSync(planPath)) {
        process.stderr.write(`not found: ${planPath}\n`);
        return 1;
      }
      process.stdout.write(`mode=plan file=${fname} stype=${stype}\n`);
    } else {
      const briefWords = arguments_.toLowerCase().split(/\s+/).slice(0, 3);
      const stype = briefWords.includes("dev") ? "dev"
        : briefWords.includes("test") ? "test"
        : "research";
      process.stdout.write(`mode=free name=${queueNameDerive(arguments_)} stype=${stype}\n`);
    }
    return 0;
  }

  return null;
}
