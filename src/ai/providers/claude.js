import Anthropic from '@anthropic-ai/sdk';
import { AiError } from '../errors.js';

// Claude through the official Anthropic SDK. The answer is constrained to the
// caller's JSON Schema with structured outputs, so it always parses.
export function createClaudeProvider({ apiKey, model, effort }) {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });

  return {
    name: 'claude',
    model,

    async generateJson({ system, messages, schema, maxTokens = 4000 }) {
      let response;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: maxTokens,
          // The shop's instructions and catalogue are the same for every message
          // in a shop, so they are cached between customers.
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          // Chat replies are short; low effort keeps them fast and cheap.
          output_config: { effort, format: { type: 'json_schema', schema } },
          // If a safety classifier declines, retry on Anthropic's recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError
          || err instanceof Anthropic.APIConnectionError) {
          throw new AiError(`Claude is busy or unreachable: ${err.message}`, { retryable: true, cause: err });
        }
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          throw new AiError('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.', { cause: err });
        }
        if (err instanceof Anthropic.APIError) {
          throw new AiError(`Claude request failed (${err.status}): ${err.message}`, { cause: err });
        }
        throw err;
      }

      if (response.stop_reason === 'refusal') {
        throw new AiError(`Claude declined to answer${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new AiError('Claude ran out of room before finishing the reply');
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new AiError('Claude returned an answer that is not valid JSON');
      }
      return { data, usage: response.usage };
    },
  };
}
