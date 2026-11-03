// Cells where this build may be worse than master, each on the operator's recorded
// word: { cell, measure, verdict }. Nothing else may land here: a regression is
// fixed, or the operator accepts it.
export const ACCEPTED = [
  {
    // Typed turns get a working block; an interrupt runs no hook, so nothing closes it.
    cell: "typed · message none · ends interrupt",
    measure: "nothing ticks once the turn is over",
    verdict: 'Operator, 2026-11-03, asked about a block left ticking after an API error or interrupt: picked "StopFailure + accept interrupt (Recommended)".',
  },
];
