// ValidationError lives in its own module so `governance.mjs` can throw it
// without importing `manifest.mjs`: that edge made the two mutually dependent,
// and the loader's split then pulled `manifest-normalize.mjs` into the same
// cycle. `manifest.mjs` re-exports it, so the public surface is unchanged.
export class ValidationError extends Error {
  constructor(errors) {
    super(`manifest validation failed:\n  - ${errors.join("\n  - ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}
