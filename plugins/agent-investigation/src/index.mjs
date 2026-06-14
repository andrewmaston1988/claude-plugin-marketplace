/**
 * agent-investigation plugin — main runtime exports.
 *
 * This module exports the core utilities for agent transcript investigation:
 * - locateAgent: find an agent transcript by ID
 * - getPaths: get platform-specific directories
 */

export { locateAgent } from "../scripts/locate-agent.mjs";
export { getPaths } from "./paths.mjs";
