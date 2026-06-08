import { connectUnified, close, projectGetByName } from "../../scripts/pipeline-db/index.mjs";

// Shared helper for CLI subcommands that take a registered <project> argument.
// Returns { db, project, projectRoot } or writes an error to stderr and returns null.
// Caller is responsible for closing db via `close(db)`.
export function lookupProjectOrFail(project) {
  if (!project) {
    process.stderr.write("error: <project> argument required\n");
    return null;
  }
  const db = connectUnified();
  const row = projectGetByName(db, project);
  if (!row) {
    close(db);
    process.stderr.write(
      `unknown project '${project}' — run \`pipeline project-list\` to see registered projects, ` +
      `or \`pipeline project-add ${project} <absolute-root-path>\` to register it.\n`
    );
    return null;
  }
  return { db, project: row.name, projectRoot: row.root_path };
}

// Variant for subcommands that just need a DB handle (registry-wide queries).
// Caller closes db.
export function openUnifiedOrFail() {
  try {
    return connectUnified();
  } catch (e) {
    process.stderr.write(`failed to open pipeline DB: ${e.message}\n`);
    return null;
  }
}
