// Published on /health: a client must replace a broker that would downgrade one
// of these to "text", because a detached broker outlives a plugin update. A leaf
// module: every hook's client imports it, and must not load the broker server.
export const KINDS = Object.freeze(["status", "question", "prompt", "turn-end", "read"]);
