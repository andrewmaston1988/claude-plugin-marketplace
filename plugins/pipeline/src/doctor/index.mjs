// Doctor check registry and dispatcher
// Loads and runs all doctor checks, collecting results

import { checkZombieRows, formatZombieRowsFindings } from "./checks/zombie-rows.mjs";

// Registry of all available checks
// Format: { name, fn, format }
//   name    — unique identifier
//   fn      — async function that returns findings array
//   format  — function to format findings for display
const CHECKS = [
  {
    name: "zombie-rows",
    fn: checkZombieRows,
    format: formatZombieRowsFindings,
  },
];

export async function runDoctorChecks({ db, paths, apply = false } = {}) {
  if (!db) throw new Error("runDoctorChecks: db is required");
  if (!paths) throw new Error("runDoctorChecks: paths is required");

  const results = [];

  for (const check of CHECKS) {
    try {
      const findings = await check.fn({ db, paths, apply });
      const detail = check.format ? check.format(findings) : JSON.stringify(findings);

      results.push({
        label: check.name,
        ok: !findings || findings.length === 0,
        warn: findings && findings.length > 0,
        detail,
      });
    } catch (e) {
      // Check failed; report error but don't hard-fail the doctor
      results.push({
        label: check.name,
        ok: false,
        warn: true,
        detail: `check failed: ${e.message || "unknown error"}`,
      });
    }
  }

  return results;
}
