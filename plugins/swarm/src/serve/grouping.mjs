// Runs are keyed by their encoded cwd. A worktree (`<root>-.worktrees-<repo>-<branch>`,
// `<repo>-.claude-worktrees-<branch>`) belongs to its repo, and the label is the key
// with the prefix every plain repo shares stripped — nothing machine-specific is assumed.
export const projectGrouping = (keys) => {
  const plain = keys.filter((k) => !/\.(claude-)?worktrees|\.swarm/.test(k));
  const norm = (k) => k.replace(/-\.(claude-)?worktrees-/g, "-").replace(/-\.swarm[^-]*/g, "");
  // The shared prefix is taken over drive-rooted keys only (`C--code-…`); a key that
  // IS the prefix (runs dispatched from the root itself) labels as its last segment.
  const rooted = plain.filter((k) => /^[A-Za-z]--/.test(k));
  let cp = rooted[0] || "";
  for (const k of rooted) { let i = 0; while (i < cp.length && i < k.length && cp[i] === k[i]) i++; cp = cp.slice(0, i); }
  cp = rooted.includes(cp) ? cp + "-" : cp.slice(0, cp.lastIndexOf("-") + 1);
  const groupOf = (k) => {
    const n = norm(k);
    let best = null;
    for (const p of plain) if ((n === p || n.startsWith(p + "-")) && (!best || p.length > best.length)) best = p;
    return best || k;
  };
  const labelOf = (g) => {
    const l = g.startsWith(cp) ? g.slice(cp.length) : g;
    return l || g.split("-").filter(Boolean).slice(-1)[0] || g;
  };
  return { groupOf, labelOf };
};