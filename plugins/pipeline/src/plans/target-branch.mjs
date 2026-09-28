// The `*Target-Branch:*` annotation, or null when the plan carries none. One parse for
// queue-plan and /merge, so a plan cannot mean two different branches to the two callers.
export function planTargetBranch(text) {
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim();
    if (s.startsWith("*Target-Branch:") || s.startsWith("* Target-Branch:")) {
      let value = s.split(":").slice(1).join(":").trim();
      while (value && (value[0] === "*" || value[0] === " ")) value = value.slice(1);
      while (value && (value[value.length - 1] === "*" || value[value.length - 1] === " ")) {
        value = value.slice(0, -1);
      }
      return value || null;
    }
  }
  return null;
}
