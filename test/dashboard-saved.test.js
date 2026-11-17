import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { normalize, matchReply, fillBlanks, numberMistakes } from '../src/dashboard/autoAnswer.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, raw, type } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': type ?? 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const token = (await call('/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'password123' } })).body.token;
  return { ...ctx, app, root, call, token, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

test('matching ignores emoji, ???, salam, bhai/apu and Bangla digits', () => {
  assert.equal(normalize('Assalamualaikum apu!!! ডেলিভারি চার্জ কত??? 😊'), 'ডেলিভারি চার্জ কত');
  assert.equal(normalize('০১৭ size'), '017 size');
  const replies = [{ _id: 1, phrases: ['ডেলিভারি চার্জ কত?'] }, { _id: 2, phrases: ['bkash number'] }];
  assert.equal(matchReply('ভাই ডেলিভারি চার্জ কত???', replies)?.reply._id, 1);
  assert.equal(matchReply('apu bkash number ta din', replies)?.reply._id, 2);
  assert.equal(matchReply('L size ache?', replies), null);
  assert.equal(fillBlanks('Hi {name}, total ৳{order_total}', { name: 'Sadia', order_total: 2220 }), 'Hi Sadia, total ৳2220');
  assert.equal(fillBlanks('Hi {name}, total ৳{order_total}', { name: 'Sadia' }), null, 'never guesses a missing blank');
  assert.deepEqual(numberMistakes('বিকাশ করুন ০১৭১২৩৪৫৬৭ তে').map((m) => m.digits), [10]);
  assert.deepEqual(numberMistakes('Send to 01712345678'), []);
});

test('a matching message gets the saved reply at no cost, even without an AI key', async () => {
  const s = await start();
  try {
    const product = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Nokshi Three-Piece', price: 2150, in_stock: true });
    const made = await s.call('/saved-replies/library', { method: 'POST', token: s.token, body: {
      name: 'Delivery charge', shortcut: 'delivery', text: 'ঢাকার ভিতরে ৳৭০, বাইরে ৳১৩০।', phrases: ['ডেলিভারি চার্জ কত?'], autoAnswer: true,
      blocks: [{ type: 'product', productId: product.id }],
    } });
    assert.equal(made.status, 201);
    assert.equal(made.body.shortcut, '/delivery');
    const dup = await s.call('/saved-replies/library', { method: 'POST', token: s.token, body: { name: 'Again', shortcut: '/delivery', text: 'x', phrases: [] } });
    assert.equal(dup.status, 409);

    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'c-auto', text: 'আপু ডেলিভারি চার্জ কত???' }));
    const sent = await until(() => s.db.messages.findOne({ kind: 'saved' }).lean());
    assert.ok(sent, 'the saved reply went out');
    assert.match(sent.text, /৳৭০[\s\S]*Nokshi Three-Piece — ৳2,150/, 'product price comes from the catalog');
    assert.equal((await until(() => s.db.aiReplies.findOne({ kind: 'saved' }).lean())).cost, 0);
    assert.ok(await until(async () => (await s.db.savedReplies.findById(made.body.id).lean()).answered_count === 1));

    // A sold-out product in the reply stops it from going out on its own.
    await s.db.products.updateOne({ _id: product.id }, { $set: { in_stock: false } });
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'c-auto-2', text: 'ডেলিভারি চার্জ কত?' }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.db.messages.countDocuments({ kind: 'saved' }), 1);

    // Paused when a teammate has taken over.
    await s.db.products.updateOne({ _id: product.id }, { $set: { in_stock: true } });
    const conv = await s.db.conversations.findOne({}).sort({ _id: 1 }).lean();
    await s.db.conversations.updateOne({ _id: conv._id }, { $set: { ai_handoff: true, human_until: new Date(Date.now() + 3_600_000) } });
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'c-auto', text: 'ডেলিভারি চার্জ কত?' }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.db.messages.countDocuments({ kind: 'saved' }), 1);
  } finally {
    await s.close();
  }
});

test('impact preview, phrase discovery and number checks', async () => {
  const s = await start();
  try {
    for (const [id, text] of [['a', 'ডেলিভারি চার্জ কত?'], ['b', 'delivery charge koto'], ['c', 'delivery charge koto apu'], ['d', 'charge koto delivery te?'], ['e', 'L size ache?'], ['f', 'delivery cost koto hobe']]) {
      await s.app.inbox.ingestMessage(inbound({ contactExternalId: id, text }));
    }
    const impact = await s.call('/saved-replies/impact', { method: 'POST', token: s.token, body: { phrases: ['delivery charge koto'] } });
    // Word order doesn't matter: "charge koto delivery te?" asks the same thing.
    assert.deepEqual([impact.body.messages, impact.body.customers], [3, 3]);
    const found = await s.call('/saved-replies/discover', { method: 'POST', token: s.token, body: { phrases: ['delivery charge koto'], name: 'Delivery charge' } });
    assert.ok(found.body.some((f) => /delivery cost koto/.test(f.text)), 'a new way of asking is suggested');
    assert.ok(!found.body.some((f) => /size/.test(f.text)));
    const check = await s.call('/saved-replies/check', { method: 'POST', token: s.token, body: { text: 'bKash 0171234567' } });
    assert.equal(check.body.warnings.length, 1);
  } finally {
    await s.close();
  }
});

test('photos upload into the database and are served back', async () => {
  const s = await start();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await s.call('/uploads', { method: 'POST', token: s.token, raw: png, type: 'image/png' });
    assert.equal(up.status, 201);
    const res = await fetch(`${s.root}${up.body.url}`);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    const bad = await s.call('/uploads', { method: 'POST', token: s.token, raw: 'hi', type: 'text/plain' });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});
