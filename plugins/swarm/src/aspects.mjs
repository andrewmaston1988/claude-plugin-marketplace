// The closed aspect set a leaf is graded on, and the outcome enum.
//
// Single home: the CLI, the skill doc, the README and the tests all key off
// these exact strings. There is deliberately NO inference here — the grading
// agent authored the leaf's prompt and declares which aspects it stressed.
// Deriving the aspect from a leaf id was tried and cut: swarm ids are subject
// nouns (`icons`, `attachments`), not kind labels, so stem mining found zero of
// the corpus's ~784 visual leaves.

// Graded on every leaf.
export const UNIVERSAL = ["adherence", "handoff", "truthfulness", "depth"];

// Graded only when the leaf stressed them.
export const CAPABILITY = ["discrimination", "code", "search", "web", "vision", "geometry"];

export const ASPECTS = [...UNIVERSAL, ...CAPABILITY];

// `not-capable` is the observed-vs-declared gap: the leaf ran, and could not do
// the thing at all. That is an outcome, never a low grade.
export const OUTCOMES = ["completed", "wrong", "failed", "timeout", "session-died", "not-capable"];

// Outcomes where output exists, so grades are required. Everything else forbids
// them: you cannot grade a report that was never submitted.
export const GRADED_OUTCOMES = ["completed", "wrong"];
