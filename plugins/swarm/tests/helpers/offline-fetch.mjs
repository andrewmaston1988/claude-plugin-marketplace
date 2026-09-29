// Preloaded into a CLI child (NODE_OPTIONS --import) so a vendor fetch fails at
// once, offline, instead of reaching the real price pages.
globalThis.fetch = async () => ({ ok: false, status: 599, text: async () => "" });
