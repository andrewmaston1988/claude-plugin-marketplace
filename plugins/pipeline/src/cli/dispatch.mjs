import { close, rowGet, rowUpdate } from "../../scripts/pipeline-db/index.mjs";
import { lookupProjectOrFail } from "./project-lookup.mjs";

export async function run(cmd, argv) {
  if (cmd === "target-branch-get") {
    const [project, feature] = argv;
    if (!project || !feature) {
      process.stderr.write("usage: target-branch-get <project> <feature>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const row = rowGet(ctx.db, ctx.project, feature);
      if (!row) {
        process.stderr.write(`not found: feature '${feature}'\n`);
        return 1;
      }
      process.stdout.write(`target_branch=${row.target_branch || "main"}\n`);
      return 0;
    } finally {
      close(ctx.db);
    }
  }

  if (cmd === "pr-title-get") {
    const [project, feature] = argv;
    if (!project || !feature) {
      process.stderr.write("usage: pr-title-get <project> <feature>\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const row = rowGet(ctx.db, ctx.project, feature);
      if (!row) {
        process.stderr.write(`not found: feature '${feature}'\n`);
        return 1;
      }
      process.stdout.write(`${row.pr_title || ""}\n`);
      return 0;
    } finally {
      close(ctx.db);
    }
  }

  if (cmd === "rebase-required-set") {
    const [project, feature, valueStr] = argv;
    if (!project || !feature || valueStr === undefined) {
      process.stderr.write("usage: rebase-required-set <project> <feature> <0|1>\n");
      return 1;
    }
    const flag = parseInt(valueStr, 10);
    if (flag !== 0 && flag !== 1) {
      process.stderr.write("error: value must be 0 or 1\n");
      return 1;
    }
    const ctx = lookupProjectOrFail(project);
    if (!ctx) return 1;
    try {
      const ok = rowUpdate(ctx.db, ctx.project, feature, { rebase_required: flag });
      if (!ok) {
        process.stderr.write(`not found: feature '${feature}'\n`);
        return 1;
      }
      process.stdout.write("OK\n");
      return 0;
    } finally {
      close(ctx.db);
    }
  }

  return null;
}
