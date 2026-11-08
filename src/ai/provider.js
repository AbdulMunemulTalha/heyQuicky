import { createClaudeProvider } from './providers/claude.js';
export { AiError } from './errors.js';

// The chat agent talks to a model only through this interface, so another
// provider (e.g. a self-hosted model) can be added without touching the agent:
//
//   provider.name                        e.g. "claude"
//   provider.model                       model ID, shown in Settings
//   await provider.generateJson({ system, messages, schema, maxTokens })
//     system:   string, the instructions
//     messages: [{ role: 'user' | 'assistant', content: string }], oldest first,
//               starting with 'user'
//     schema:   JSON Schema the answer must match
//     returns   { data, usage }   data is the parsed object
//     throws    AiError on failure (err.retryable says whether to try again later)

const PROVIDERS = {
  claude: createClaudeProvider,
};

// Returns null when AI is not configured on this server.
export function createAiProvider(aiConfig) {
  if (!aiConfig?.apiKey) return null;
  const make = PROVIDERS[aiConfig.provider];
  if (!make) throw new Error(`Unknown AI_PROVIDER "${aiConfig.provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
  return make(aiConfig);
}
