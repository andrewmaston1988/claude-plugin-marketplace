import { createDefaultProviderRegistry } from "./providers.mjs";
import { defaultCodexProviderAdapter } from "./codex.mjs";
import { createOllamaProviderAdapter } from "./discovery.mjs";

// Lives apart from providers.mjs because codex.mjs imports providers.mjs.
export function defaultProviderRegistry({ additionalProviders = [] } = {}) {
  const ollama = createOllamaProviderAdapter();
  return createDefaultProviderRegistry({
    codexAdapter: defaultCodexProviderAdapter,
    ollamaCapabilities: ollama.capabilities,
    additionalProviders,
  });
}
