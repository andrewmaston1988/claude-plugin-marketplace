// Loaded with `node --import` by the CLI tests: registers a resolve hook that appends every
// file: module URL to UI_PROBE_MODULE_LOG, so a test can prove which modules a subcommand
// loaded. The hook body lives in a data: URL so this file runs only as the entry, never as
// the hook itself. Inert when the env var is unset.

import { register } from "node:module";
import { writeFileSync } from "node:fs";

const log = process.env.UI_PROBE_MODULE_LOG;
if (log) {
  writeFileSync(log, "");
  const hookSource = [
    'import { appendFileSync } from "node:fs";',
    "export async function resolve(specifier, context, nextResolve) {",
    "  const resolved = await nextResolve(specifier, context);",
    '  if (resolved.url.startsWith("file:")) {',
    "    try {",
    '      appendFileSync(process.env.UI_PROBE_MODULE_LOG, resolved.url + "\\n");',
    "    } catch {}",
    "  }",
    "  return resolved;",
    "}",
  ].join("\n");
  register(`data:text/javascript,${encodeURIComponent(hookSource)}`);
}
