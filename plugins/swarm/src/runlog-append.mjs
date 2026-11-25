// The one writer of run.log. Apart from results.mjs so a caller that only records an
// event does not pull the reporting graph — and its provider-registry import cycle — in.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export function appendRunLog(dir, obj) {
  appendFileSync(join(dir, "run.log"), JSON.stringify(obj) + "\n");
}
