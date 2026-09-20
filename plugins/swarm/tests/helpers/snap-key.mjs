// Independent oracle for worktree.snapshotKey: rows that pin tree paths must not call the source's own hash.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const oracleSnapKey = (s) => {
  const p = resolve(s);
  return createHash("sha1").update(process.platform === "win32" ? p.toLowerCase() : p).digest("hex").slice(0, 12);
};
