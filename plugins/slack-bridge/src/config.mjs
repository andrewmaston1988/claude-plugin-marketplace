import { readFileSync } from "node:fs";

const DEFAULTS = {
  claude: {
    addDir: null,
    timeout: 180_000,
    model: null,
  },
  proxy: {
    url: "http://localhost:11434",
    authToken: "ollama",
  },
  slack: {
    onlyChannel: null,
    historyLimit: 0,
    notifyChannel: null,
    sessionKey: "channel-thread",
    verbMode: "static",
    verbModel: "claude-haiku-4-5",
  },
  extensions: [],
};

const REQUIRED = ["tokens.bot", "tokens.app", "claude.cwd"];

function get(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function merge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = v !== null && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object"
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export function loadConfig({ configPath }) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(`Config file not found: ${configPath}\nRun 'claude-slack setup' to create one.`);
    }
    const line = e.message.match(/position (\d+)/)
      ? ` (near position ${e.message.match(/position (\d+)/)[1]})`
      : "";
    throw new Error(`Config file is not valid JSON: ${configPath}${line}\n${e.message}`);
  }

  const config = merge(DEFAULTS, file);

  // Env var overrides
  if (process.env.SLACK_BOT_TOKEN) config.tokens = { ...config.tokens, bot: process.env.SLACK_BOT_TOKEN };
  if (process.env.SLACK_APP_TOKEN) config.tokens = { ...config.tokens, app: process.env.SLACK_APP_TOKEN };
  if (process.env.CLAUDE_CWD) config.claude = { ...config.claude, cwd: process.env.CLAUDE_CWD };

  for (const path of REQUIRED) {
    if (!get(config, path)) {
      throw new Error(`Missing required config field: ${path}\nCheck your config at: ${configPath}`);
    }
  }

  const timeout = config.claude?.timeout;
  if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0 || !Number.isFinite(timeout))) {
    throw new Error(`Config field claude.timeout must be a positive number (got: ${JSON.stringify(timeout)})\nCheck your config at: ${configPath}`);
  }

  return config;
}
