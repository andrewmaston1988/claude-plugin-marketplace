import { createDefaultProviderRegistry } from "./providers.mjs";
import { defaultCodexProviderAdapter } from "./codex.mjs";

// Lives apart from providers.mjs because codex.mjs imports providers.mjs.
export function defaultProviderRegistry() {
  return createDefaultProviderRegistry({ codexAdapter: defaultCodexProviderAdapter });
}
