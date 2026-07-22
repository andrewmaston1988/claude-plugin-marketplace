// Canonical way for hook-injected prompts to name this plugin's skill.
// Bare "checkpoint" collides with Claude Code's built-in checkpoint/rewind
// feature, so agents reach for that instead of the skill. Always qualify.

export const SKILL_ID = 'checkpoint:checkpoint';

export const SKILL_INVOCATION = `the Skill tool with skill="${SKILL_ID}"`;

export const SKILL_DISAMBIGUATION =
  `(That is the "${SKILL_ID}" plugin skill — not the built-in checkpoint/rewind `
  + `feature of the Claude Code CLI, and not a "checkpoint" shell command.)`;
