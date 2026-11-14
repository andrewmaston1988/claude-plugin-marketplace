// Which MCP servers a leaf starts. Pure: the CLI's own server names are the
// vocabulary — user/project scope names verbatim, plugin servers as
// plugin:<plugin>:<server>. The off set is the machine's list, minus what the
// leaf's repo turns back on, minus what the leaf's own tools name.

// Repo names match case-insensitively on Windows, the same rule the leaf guard uses.
export function namesEqual(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The tool-name prefix one server's tools carry. A plugin server's tools drop the
// colons (`mcp__plugin_<plugin>_<server>`), which is the form the CLI hands a leaf.
export function toolPrefixFor(server) {
  const name = String(server);
  const plugin = /^plugin:([^:]+):(.+)$/.exec(name);
  return plugin ? `mcp__plugin_${plugin[1]}_${plugin[2]}` : `mcp__${name}`;
}

// Forward only: a tool belongs to a server when it IS the server's prefix or sits
// under it. `mcp__blender_extra` is a different server, not a blender tool.
export function toolUsesServer(tool, server) {
  const bare = String(tool).replace(/\(.*\)$/, "").trim();
  const prefix = toolPrefixFor(server);
  return bare === prefix || bare.startsWith(prefix + "__");
}

function toolList(allowedTools) {
  return String(allowedTools || "").split(",").map((t) => t.trim()).filter(Boolean);
}

export function leafMcpOff({ project, cfg, allowedTools }) {
  const on = new Set(project?.mcp?.on || []);
  const tools = toolList(allowedTools);
  const off = (cfg?.mcp?.off || []).filter(
    (server) => !on.has(server) && !tools.some((tool) => toolUsesServer(tool, server)),
  );
  return [...new Set(off)].sort();
}

// `claude mcp list`'s body: `<name>: <target> - <status>`, one server per line.
// Everything else (the health-check header, blanks) is not a server.
export function parseMcpList(text) {
  const servers = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = /^(.+?): (.+) - (.+)$/.exec(raw.trim());
    if (!m) continue;
    servers.push({ name: m[1].trim(), target: m[2].trim(), status: m[3].trim() });
  }
  return servers;
}

// The minimal config `swarm mcp set` writes. `off` and `repos` ARE the new state:
// a repo's `on` is intersected with `off`, a project whose `on` empties loses it,
// and an entry narrowed to its bare name is dropped entirely. Never mutates.
export function cleanMcpConfig(rawCfg, { off = [], repos = [] } = {}) {
  const offNames = [...new Set(off)].sort();
  const next = structuredClone(rawCfg || {});
  const onFor = (name) => {
    const repo = repos.find((r) => namesEqual(r.name, name));
    return [...new Set(repo?.on || [])].filter((server) => offNames.includes(server)).sort();
  };
  const existing = Array.isArray(next.projects) ? next.projects : [];
  const projects = existing.map((entry) => {
    const copy = { ...entry };
    const on = onFor(entry.name);
    if (on.length) copy.mcp = { ...(entry.mcp || {}), on };
    else delete copy.mcp;
    return copy;
  });
  for (const repo of repos) {
    if (existing.some((entry) => namesEqual(entry.name, repo.name))) continue;
    const on = onFor(repo.name);
    if (on.length) projects.push({ name: repo.name, mcp: { on } });
  }
  const kept = projects.filter((entry) => Object.keys(entry).length > 1);
  const out = { ...next, projects: kept };
  if (!kept.length && !Object.hasOwn(next, "projects")) delete out.projects;
  if (offNames.length) out.mcp = { off: offNames };
  else delete out.mcp;
  return out;
}
