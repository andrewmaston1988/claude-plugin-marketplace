/**
 * @typedef {Object} HeartbeatCtx
 * @property {string} channel - Slack channel ID
 * @property {string|undefined} sessionId - Current Claude session ID
 * @property {"running"|"running-tool"} state - Current heartbeat state
 * @property {string|undefined} currentTool - Active tool name (if state === "running-tool")
 * @property {number} elapsedSec - Seconds elapsed since message was received
 * @property {object} config - Full bridge config
 */

/**
 * @typedef {Object} PromptCtx
 * @property {string} channel - Slack channel ID
 * @property {string|undefined} sessionId - Current session ID (undefined = new session)
 * @property {boolean} isFirstMessage - True when no existing session
 * @property {string} message - The user's raw message text (after bot-mention strip)
 * @property {object} config - Full bridge config
 */

/**
 * @typedef {Object} ToolEventCtx
 * @property {string} tool - Tool name
 * @property {string} channel - Slack channel ID
 * @property {string|undefined} sessionId - Current session ID
 */

/**
 * @typedef {Object} Extension
 * @property {string} name - Extension identifier (used in logs)
 * @property {function(HeartbeatCtx): Promise<string|null>} [heartbeatAugment] - Appended to heartbeat body each tick
 * @property {function(PromptCtx): Promise<string|null>} [promptInject] - Prepended to prompt before Claude invocation
 * @property {function(ToolEventCtx): Promise<string|null>} [toolVerb] - First-wins verb override for heartbeat
 * @property {function(): Promise<void>} [selfCheck] - Called at startup; throw to log a warning (bridge continues)
 */
