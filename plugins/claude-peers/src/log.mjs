// stdout is the MCP protocol in the mcp subcommand — all logging goes to stderr.
export function createLogger(prefix) {
  return (msg) => process.stderr.write(`[${prefix}] ${msg}\n`);
}
