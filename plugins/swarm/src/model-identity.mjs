// Roster membership only. Shape and provider mismatch are `resolve()`'s job
// (providers.mjs), so every seat meets them before this runs.
//
// What an absent name is worth depends on what the roster is: the Claude catalog
// is read locally and exact, but it can predate a release, so only a catalog
// younger than a week may refuse. Ollama and Codex rosters are network banks that
// can be stale or empty on a fresh install, so an absent name there never refuses
// — it warns and names the refresh.

// Seven days, as the plan states it. A lagging catalog is the whole reason this
// gate exists, so the number lives here and the test steps against it literally.
const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const CATALOG_IDS_SHOWN = 5;

function rosterIds(cache, provider) {
  const wanted = String(provider || "").toLowerCase();
  return (Array.isArray(cache) ? cache : [])
    .filter((row) => String(row?.provider || "").toLowerCase() === wanted)
    .map((row) => String(row?.model ?? ""))
    .filter(Boolean);
}

function ageText(ms) {
  const days = Math.floor(ms / (24 * 60 * 60_000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.floor(ms / (60 * 60_000)));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Push at most one line: an error when a fresh Claude catalog cannot place the
 * model, a warning when the evidence is only a bank that may have moved on.
 * `catalogFetchedAt` is the local catalog's own `fetchedAt` (ms); absent means the
 * caller could not read one, and then only a warning is possible.
 */
export function checkModelIdentity({
  model, provider, cache = [], catalogFetchedAt, label = "model", errors, warnings, now = Date.now(),
}) {
  const id = String(model || "");
  if (!id) return;
  const ids = rosterIds(cache, provider);
  // An empty roster is not evidence of a typo — a fresh install has none.
  if (!ids.length || ids.includes(id)) return;

  const listed = ids.slice(0, CATALOG_IDS_SHOWN).map((x) => `"${x}"`).join(", ");
  if (provider === "claude") {
    const age = Number.isFinite(catalogFetchedAt) ? now - catalogFetchedAt : null;
    if (age !== null && age >= 0 && age < CATALOG_MAX_AGE_MS) {
      errors?.push(
        `${label}: model '${id}' is not in the Claude catalog (fetched ${ageText(age)} ago) — ` +
        `pick one it lists (${listed}) or fix the id; a model newer than the catalog needs a current one`
      );
      return;
    }
    warnings?.push(
      `${label}: model '${id}' is not in the Claude catalog, which is ${age === null ? "of unknown age" : `${ageText(age)} old`} — ` +
      `it may predate the model, so the seat is allowed; the catalog lists: ${listed}`
    );
    return;
  }

  if (provider === "ollama" || provider === "codex") {
    warnings?.push(
      `${label}: model '${id}' is not in the banked ${provider} roster — run 'swarm models' to refresh it; ` +
      `the seat is allowed in case the model is newer than the roster`
    );
  }
}
