import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { createTranscriber } from '../src/ai/transcribe.js';
import { fetchAttachment } from '../src/ai/media.js';
import { usageCost } from '../src/ai/pricing.js';
import { setup, inbound } from './helpers.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const ANSWER = { reply: 'জি আপু', handoff: false, handoff_reason: '', intent: 'product_info', products: [], quick_replies: [], size_chart_product: 0,
  order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '' }, act_now: false, act_now_reason: '' };

async function shop({ transcriber = null, fetchMedia } = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const calls = [];
  const fetched = [];
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) { calls.push(req); return { data: ANSWER, usage: {} }; } };
  const inbox = createInbox(ctx.db, ctx.config);
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, transcriber,
    fetchMedia: async (args) => { fetched.push(args.attachment); return fetchMedia(args); } });
  const say = async (attachments, text = '') => {
    const { conversation, message } = await inbox.ingestMessage(inbound({ contactExternalId: 'voice', text, attachments }));
    return { result: await agent.respond(conversation.id, message.id), id: conversation.id, messageId: message.id };
  };
  return { ...ctx, calls, fetched, say };
}

test('a voice note is transcribed once, answered like text, and charged at the real per-minute cost', async () => {
  const heard = [];
  const transcriber = { model: 'gpt-transcribe', async transcribe(file) { heard.push(file); return { text: 'kurti ta M size e ache?', usage: { type: 'duration', seconds: 12 } }; } };
  const s = await shop({ transcriber, fetchMedia: async () => ({ bytes: Buffer.from('OggS'), mime: 'audio/ogg' }) });
  const { result, messageId } = await s.say([{ type: 'audio', url: 'https://cdn.example/v.ogg' }]);
  assert.equal(result, 'sent');
  assert.equal(heard.length, 1);
  assert.match(s.calls[0].messages.at(-1).content, /\[voice note: "kurti ta M size e ache\?"\]/);
  const msg = await s.db.messages.findById(messageId).lean();
  assert.equal(msg.attachments[0].transcript, 'kurti ta M size e ache?', 'kept so it is not transcribed again');
  const voice = await s.db.aiReplies.findOne({ kind: 'voice' }).lean();
  assert.equal(voice.model, 'gpt-transcribe');
  assert.ok(Math.abs(voice.cost_usd - 0.0009) < 1e-9, '12 seconds at $0.0045 a minute');
});

test('a voice note that can\'t be opened, or no OpenAI key, leaves it to the team', async () => {
  const broken = await shop({ transcriber: { model: 'gpt-transcribe', async transcribe() { throw new Error('boom'); } }, fetchMedia: async () => ({ bytes: Buffer.from('x'), mime: 'audio/ogg' }) });
  const a = await broken.say([{ type: 'audio', url: 'https://cdn.example/v.ogg' }]);
  assert.match(broken.calls[0].messages.at(-1).content, /voice note that couldn't be opened/);
  assert.equal((await broken.db.messages.findById(a.messageId).lean()).attachments[0].transcript_failed, true);

  const noKey = await shop({ fetchMedia: async () => { throw new Error('should not download'); } });
  await noKey.say([{ type: 'audio', url: 'https://cdn.example/v.ogg' }]);
  assert.equal(noKey.fetched.length, 0);
  assert.match(noKey.calls[0].messages.at(-1).content, /\[customer sent a voice note\]/);
  assert.equal(createTranscriber({ apiKey: '' }), null);
});

test('customer photos are shown to the model as images, at most three per reply', async () => {
  const s = await shop({ fetchMedia: async () => ({ bytes: JPEG, mime: 'application/octet-stream' }) });
  const photos = [1, 2, 3, 4].map((i) => ({ type: 'image', url: `https://cdn.example/${i}.jpg` }));
  await s.say(photos, 'eta ache?');
  const last = s.calls[0].messages.at(-1);
  assert.equal(last.content[0].type, 'text');
  assert.match(last.content[0].text, /eta ache\? \[customer sent a photo, shown below\]/);
  const images = last.content.filter((b) => b.type === 'image');
  assert.equal(images.length, 3);
  assert.deepEqual(images[0].source, { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') }, 'type read from the file itself');
});

test('a photo that won\'t download is marked, and the AI is told it couldn\'t be opened', async () => {
  const s = await shop({ fetchMedia: async () => { throw new Error('403'); } });
  const { messageId } = await s.say([{ type: 'image', url: 'https://cdn.example/x.jpg' }]);
  assert.equal(typeof s.calls[0].messages.at(-1).content, 'string');
  assert.match(s.calls[0].messages.at(-1).content, /photo that couldn't be opened/);
  assert.equal((await s.db.messages.findById(messageId).lean()).attachments[0].seen_failed, true);
});

test('WhatsApp media is looked up with the channel token, then downloaded with it', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([url, opts.headers?.Authorization]);
    if (url.includes('graph.facebook.com')) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/wa/1', mime_type: 'audio/ogg; codecs=opus', file_size: 10 }), { status: 200 });
    return new Response(Buffer.from('OggS'), { status: 200 });
  };
  const out = await fetchAttachment({ channel: { platform: 'whatsapp', access_token: 'TKN' }, attachment: { type: 'audio', mediaId: '987' }, graphVersion: 'v23.0', maxBytes: 1000, fetchImpl });
  assert.deepEqual(seen, [['https://graph.facebook.com/v23.0/987', 'Bearer TKN'], ['https://lookaside.fbsbx.com/wa/1', 'Bearer TKN']]);
  assert.equal(out.mime, 'audio/ogg; codecs=opus');
  assert.equal(out.bytes.toString(), 'OggS');
  await assert.rejects(fetchAttachment({ channel: {}, attachment: { url: 'https://x/big' }, maxBytes: 2, fetchImpl: async () => new Response(Buffer.from('12345')) }), /too large/);
});

test('the transcription adapter posts the audio to OpenAI and prices the usage', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, opts }; return new Response(JSON.stringify({ text: ' ji ache ', usage: { type: 'duration', seconds: 30 } }), { status: 200 }); };
  const t = createTranscriber({ apiKey: 'sk-test', fetchImpl });
  const out = await t.transcribe({ bytes: Buffer.from('OggS'), mime: 'audio/ogg; codecs=opus' });
  assert.equal(sent.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(sent.opts.headers.Authorization, 'Bearer sk-test');
  assert.equal(sent.opts.body.get('model'), 'gpt-transcribe');
  assert.equal(sent.opts.body.get('file').name, 'voice.ogg');
  assert.deepEqual(out, { text: 'ji ache', usage: { type: 'duration', seconds: 30 } });
  assert.ok(Math.abs(usageCost('gpt-transcribe', out.usage).usd - 0.00225) < 1e-9);
  const bad = createTranscriber({ apiKey: 'sk-bad', fetchImpl: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(bad.transcribe({ bytes: Buffer.from('x') }), /OPENAI_API_KEY/);
});
