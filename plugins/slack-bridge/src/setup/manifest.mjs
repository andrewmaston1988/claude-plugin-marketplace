import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../assets/slack-app-manifest.yaml");

/**
 * Render the Slack app manifest YAML with optional substitutions.
 *
 * @param {{ displayName?: string, includeUserScopes?: boolean }} opts
 * @returns {string} YAML string ready to paste into api.slack.com
 */
export function renderManifest({ displayName = "Claude Code", includeUserScopes = false } = {}) {
  let yaml = readFileSync(ASSET_PATH, "utf8");

  yaml = yaml.replace(/\$\{DISPLAY_NAME\}/g, displayName);

  if (includeUserScopes) {
    yaml = yaml
      .replace(/^\s*# user-scope block enabled.*\n/m, "")
      .replace(/^\s*# user:\n/m, "    user:\n")
      .replace(/^\s*#   - chat:write\n/m, "      - chat:write\n")
      .replace(/^\s*#   - users:write\n/m, "      - users:write\n")
      .replace(/^\s*#   - users\.profile:write\n/m, "      - users.profile:write\n");
  }

  return yaml;
}
