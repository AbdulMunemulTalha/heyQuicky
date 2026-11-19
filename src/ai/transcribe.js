import { AiError } from './errors.js';

// Voice notes to text (AI-04) with OpenAI's transcription API, over plain HTTP.
// POST https://api.openai.com/v1/audio/transcriptions (multipart: file, model), up to 25 MB.
// The language is detected automatically (Bangla, Banglish speech, English).
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const EXT = { 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/mp4': 'mp4' };

// Returns null when OPENAI_API_KEY isn't set: voice notes then go to the team as before.
export function createTranscriber({ apiKey, model = 'gpt-transcribe', fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return null;
  return {
    model,
    // Returns { text, usage } — usage is { type: 'duration', seconds } or token counts, as OpenAI reports it.
    async transcribe({ bytes, mime = 'audio/ogg' }) {
      const type = String(mime).split(';')[0].trim().toLowerCase();
      const form = new FormData();
      form.append('model', model);
      form.append('file', new Blob([bytes], { type }), `voice.${EXT[type] ?? 'ogg'}`);
      let res;
      try {
        res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        throw new AiError(`Voice transcription is unreachable: ${err.message}`, { retryable: true, cause: err });
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new AiError('The OpenAI API key was rejected. Check OPENAI_API_KEY.');
      if (!res.ok) throw new AiError(`Voice transcription failed (${res.status}): ${data?.error?.message ?? 'unknown error'}`, { retryable: res.status === 429 || res.status >= 500 });
      return { text: String(data.text ?? '').trim(), usage: data.usage ?? {} };
    },
  };
}
