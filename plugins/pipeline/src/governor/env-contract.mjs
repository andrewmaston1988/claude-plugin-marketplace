// Shared governor spawn contract definition and validator.
// Used by both the doctor check and the test suite to avoid drift.

export const CONTRACT_VARS = new Set([
  "CORRELATION_ID",
  "REPORT_TYPE",
  "REPORT_DATE",
  "REPORT_MONTH",
  "PIPELINE_DB",
  "PLUGIN_DIR",
]);

// Well-known OS / shell vars that any process can expect in its env,
// plus prose template placeholders that appear as $VAR in doc strings.
export const ALWAYS_PRESENT = new Set([
  "PATH", "HOME", "USER", "SHELL", "USERPROFILE", "APPDATA", "TEMP", "TMP",
  "BASELINE", // appears in report-format doc strings, not a real spawn var
]);

// Find $VAR references in template content that are not in the contract or always-present sets.
// Only matches multi-char uppercase names (ignores prose placeholders like $X, $Y).
export function findUnknownTemplateVars(templateContent) {
  const varRefs = [...templateContent.matchAll(/\$([A-Z_][A-Z0-9_]{2,})/g)].map(m => m[1]);
  const unique = [...new Set(varRefs)].filter(v => !ALWAYS_PRESENT.has(v));
  return unique.filter(v => !CONTRACT_VARS.has(v));
}
