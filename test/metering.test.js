import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { usageCost, toTaka } from '../src/ai/pricing.js';
import { setup, inbound } from './helpers.js';

// 1,000 fresh input + 20,000 cached + 200 output tokens on Haiku 5.5.
const USAGE = { input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0, output_tokens: 200 };

function provider() {
  return { name: 'fake', model: 'claude-haiku-5-5', calls: 0,
    async generateJson() { this.calls += 1; return { data: { reply: 'জি আপু, আছে।', handoff: false, handoff_reason: '', intent: 'price' }, usage: USAGE }; } };
}

async function shop(env = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', ...env } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const p = provider();
  const notes = [];
  const inbox = createInbox(ctx.db, ctx.config);
  const agent = createAgent(ctx.db, inbox, p, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, notify: async (n) => { notes.push(n); return []; } });
  const ask = async (text, who = 'buyer') => {
    const { conversation, message } = await inbox.ingestMessage(inbound({ contactExternalId: who, text }));
    return { result: await agent.respond(conversation.id, message.id), conversation };
  };
  return { ...ctx, p, notes, ask };
}

test('a reply is priced from its real token use, with cache savings', () => {
  const c = usageCost('claude-haiku-5-5', USAGE);
  // 1,000 × $0.10 + 20,000 × $0.01 + 200 × $0.50 per million = $0.0004
  assert.equal(Math.round(c.usd * 1e7) / 1e7, 0.0004);
  // Cache savings: 20,000 tokens read at $0.01 instead of $0.10 per million = $0.0018.
  assert.equal(Math.round(c.savedUsd * 1e7) / 1e7, 0.0018);
  assert.equal(toTaka(c.usd, { usdToBdt: 122, markupPct: 30 }), 0.0634, '$0.0004 × 122 × 1.3');
  assert.equal(usageCost('unknown-model', USAGE), null);
  const long = usageCost('claude-haiku-5-5', { input_tokens: 120_000, output_tokens: 0 });
  assert.equal(Math.round(long.usd * 1e6) / 1e6, 0.06, 'over 100k tokens Haiku 5.5 bills at $0.50 / MTok');
});

test('with charging off, costs are recorded but nothing is deducted and the AI keeps answering', async () => {
  const s = await shop({ USD_TO_BDT: '122', AI_MARKUP_PCT: '30' });
  const { result } = await s.ask('দাম কত?');
  assert.equal(result, 'sent');
  const r = await s.db.aiReplies.findOne({ workspace_id: s.ws, kind: 'reply' }).lean();
  assert.equal(r.cost, 0.0634);
  assert.equal(r.input_tokens, 1000);
  assert.equal(r.cache_read_tokens, 20000);
  assert.ok(r.saved > 0);
  assert.equal((await s.db.workspaces.findById(s.ws).lean()).credit_balance ?? 0, 0, 'nothing deducted');
});

test('with charging on, credit is deducted, the owner is warned, and the AI pauses at zero', async () => {
  const s = await shop({ AI_CREDIT_ENFORCED: '1', USD_TO_BDT: '100000', AI_MARKUP_PCT: '0' }); // big rate so each reply costs ৳40
  await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { credit_balance: 120, 'settings.caps': { monthly: null, alert_below: 100 } } });
  assert.equal((await s.ask('দাম কত?')).result, 'sent');
  let ws = await s.db.workspaces.findById(s.ws).lean();
  assert.equal(ws.credit_balance, 80, '৳120 − ৳40');
  assert.ok(await s.db.credit.exists({ workspace_id: s.ws, type: 'ai_reply', amount: -40 }));
  assert.ok(s.notes.some((n) => n.event === 'credit' && /low/.test(n.title)), 'crossing ৳100 warns once');

  await s.ask('আর?'); await s.ask('ok?');
  ws = await s.db.workspaces.findById(s.ws).lean();
  assert.ok(ws.credit_balance <= 0);
  assert.ok(s.notes.some((n) => /finished/.test(n.title)));

  const calls = s.p.calls;
  const { result, conversation } = await s.ask('hello?', 'buyer2');
  assert.equal(result, 'no_credit');
  assert.equal(s.p.calls, calls, 'the model is not called with no credit');
  const conv = await s.db.conversations.findById(conversation.id).lean();
  assert.equal(conv.ai_handoff, true);
  assert.match(conv.ai_handoff_reason, /credit finished/);
});

test('the monthly spend cap pauses the AI too', async () => {
  const s = await shop({ AI_CREDIT_ENFORCED: '1', USD_TO_BDT: '100000' });
  await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { credit_balance: 1000, 'settings.caps': { monthly: 50, alert_below: 0 } } });
  assert.equal((await s.ask('দাম কত?')).result, 'sent');
  assert.equal((await s.ask('আর?')).result, 'sent', '৳40 spent, still under ৳50');
  assert.equal((await s.ask('শেষ?')).result, 'cap_reached');
});
