import { resolve } from "node:path";
import { generateSessionFile } from "../../scripts/session-gen.mjs";
import { connectUnified, projectGetByName, close } from "../../scripts/pipeline-db/index.mjs";
import { getFlag } from "./helpers.mjs";

export async function run(cmd, argv) {
  if (cmd !== "session-generate") return null;

  const [project, planFile, sessionType] = argv;
  if (!project || !planFile || !sessionType) {
    process.stderr.write(
      "usage: session-generate <project> <plan-file> <session-type> [--project-root <path>] [--branch <name>]\n"
    );
    return 1;
  }

  const branch = getFlag("--branch", argv) || undefined;

  let projectRoot = getFlag("--project-root", argv);
  if (projectRoot) {
    projectRoot = resolve(projectRoot);
  } else {
    const db = connectUnified();
    try {
      const row = projectGetByName(db, project);
      projectRoot = row?.root_path || null;
    } finally {
      close(db);
    }
    if (!projectRoot) {
      process.stderr.write(
        `ERROR: project '${project}' not registered; pass --project-root <path> or run 'pipeline project-add'\n`
      );
      return 1;
    }
  }

  try {
    const path = generateSessionFile(project, planFile, sessionType, { projectRoot, branch });
    process.stdout.write(path + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(`session generation failed: ${e.message}\n`);
    return 1;
  }
}
