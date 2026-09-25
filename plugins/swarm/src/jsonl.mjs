export function parseJsonObjectLine(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
