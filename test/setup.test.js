import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { buildSystemPrompt } from '../src/ai/prompt.js';
import { parseCsv, productsFromRows, googleSheetCsvUrl } from '../src/productImport.js';
import { setup, inbound } from './helpers.js';

function fakeProvider(answer = () => ({ reply: 'Ji ache, dam 1,200 taka.', handoff: false, handoff_reason: '', intent: 'price' })) {
  const calls = [];
  return {
    name: 'fake', model: 'fake-1', calls,
    async generateJson(request) {
      calls.push(request);
      return { data: await answer(request), usage: {} };
    },
  };
}

// An app on a random port with helpers to call it as the shop owner.
async function server({ aiProvider = null, fetchImpl, env = {} } = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', ...env } });
  const { server: srv } = createApp(ctx.db, ctx.config, { aiProvider, fetchImpl });
  await new Promise((resolve) => srv.listen(0, resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };
  const { data } = await call('/auth/login', { method: 'POST', body: { email: 'owner@shop.test', password: 'password123' } });
  const close = () => new Promise((resolve) => srv.close(resolve));
  return { ...ctx, call, base, token: data.token, close };
}

test('sign-up saves the mobile and survey answers and starts setup at channels', async () => {
  const s = await server();
  try {
    const bad = await s.call('/auth/signup', { method: 'POST', body: { businessName: 'Nokshi', name: 'Talha', email: 'a@b.test', password: 'password123', phone: '123' } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /Bangladeshi/);
    const badSurvey = await s.call('/auth/signup', {
      method: 'POST', body: { businessName: 'Nokshi', name: 'Talha', email: 'a@b.test', password: 'password123', survey: { team_size: 'army' } },
    });
    assert.equal(badSurvey.status, 400);

    const ok = await s.call('/auth/signup', {
      method: 'POST',
      body: { businessName: 'Nokshi Threads', name: 'Talha', email: 'talha@nokshi.test', password: 'password123', phone: '01712-345678',
        survey: { messages_per_day: '50_200', team_size: 'just_me', ad_spend: 'under_20k' } },
    });
    assert.equal(ok.status, 201);
    const user = await s.db.users.findOne({ email: 'talha@nokshi.test' }).lean();
    const ws = await s.db.workspaces.findById(user.workspace_id).lean();
    assert.equal(user.phone, '01712345678');
    assert.equal(ws.onboarding_step, 'channels');
    assert.deepEqual({ ...ws.signup_survey }, { messages_per_day: '50_200', team_size: 'just_me', ad_spend: 'under_20k' });
    const me = await s.call('/me', { token: ok.data.token });
    assert.equal(me.data.support.email, 'info@heyquicky.com');
  } finally {
    await s.close();
  }
});

test('every onboarding step saves its settings, with validation', async () => {
  const s = await server();
  try {
    const patch = (body) => s.call('/workspace', { method: 'PATCH', token: s.token, body });
    const bad = [
      [{ category: 'weapons' }, /what you sell/],
      [{ orderFields: [{ label: '' }] }, /needs a name/],
      [{ orderFields: Array.from({ length: 13 }, () => ({ label: 'x' })) }, /up to 12/],
      [{ audience: ['aliens'] }, /who you sell to/],
      [{ freeDeliveryOver: -1 }, /whole number/],
      [{ bkashNumber: '999' }, /bKash number/],
      [{ aiStyle: 'shouty' }, /writing style/],
      [{ aiAddress: 'boss' }, /address customers/],
      [{ aiSales: 'pushy' }, /sales style/],
      [{ aiName: 'x'.repeat(31) }, /too long/],
      [{ onboardingStep: 'launch' }, /Unknown onboarding step/],
    ];
    for (const [body, message] of bad) {
      const res = await patch(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.data.error, message);
    }

    const { data } = await patch({
      category: 'clothing', orderFields: [{ label: 'Size', hint: 'S, M, L' }, { label: 'Colour' }],
      address: 'Mirpur 10, Dhaka', phone: '01712345678', sellsOffline: true, audience: ['women', 'girls', 'women'],
      deliveryInsideDhaka: 70, deliveryInsideDays: '1–2', deliveryOutsideDhaka: 130, deliveryOutsideDays: '2–3',
      cashOnDelivery: false, freeDeliveryOver: 3000, bkashNumber: '01812-345678', nagadNumber: '',
      aiName: 'Nusrat', aiStyle: 'bangla', aiAddress: 'apu', aiSales: 'direct', onboardingStep: 'test',
    });
    assert.deepEqual(
      { ...data, id: undefined, name: undefined, shopNotes: undefined },
      { id: undefined, name: undefined, shopNotes: undefined, phone: '01712345678', category: 'clothing', onboardingStep: 'test',
        deliveryInsideDhaka: 70, deliveryOutsideDhaka: 130, aiMode: 'off',
        orderFields: [{ label: 'Size', hint: 'S, M, L' }, { label: 'Colour', hint: '' }],
        address: 'Mirpur 10, Dhaka', sellsOffline: true, audience: ['women', 'girls'], deliveryInsideDays: '1–2', deliveryOutsideDays: '2–3',
        cashOnDelivery: false, freeDeliveryOver: 3000, bkashNumber: '01812345678', nagadNumber: '',
        aiName: 'Nusrat', aiStyle: 'bangla', aiAddress: 'apu', aiSales: 'direct' },
    );
    assert.equal((await patch({ freeDeliveryOver: null })).data.freeDeliveryOver, null, 'free delivery can be switched off');
    const done = await patch({ aiMode: 'auto', onboardingStep: 'done' });
    assert.deepEqual([done.data.aiMode, done.data.onboardingStep], ['auto', 'done']);
  } finally {
    await s.close();
  }
});

test('the AI prompt uses the onboarding settings', () => {
  const prompt = buildSystemPrompt({
    workspace: {
      name: 'Nokshi Threads', category: 'clothing', phone: '01712345678', address: 'Mirpur 10, Dhaka', audience: ['women'],
      delivery_inside_dhaka: 70, delivery_outside_dhaka: 130, delivery_inside_days: '1–2', delivery_outside_days: '2–3',
      cash_on_delivery: false, free_delivery_over: 3000, bkash_number: '01812345678',
      ai_name: 'Nusrat', ai_style: 'bangla', ai_address: 'apu', ai_sales: 'direct',
      order_fields: [{ label: 'Size', hint: 'S, M, L' }, { label: 'Colour', hint: '' }],
    },
    products: [], savedReplies: [],
  });
  assert.match(prompt, /sells clothing/);
  assert.match(prompt, /You are Nusrat, a moderator of Nokshi Threads's page/);
  assert.match(prompt, /write in polite Bangla script/);
  assert.match(prompt, /Address customers as "Apu"/);
  assert.match(prompt, /Be direct/);
  assert.match(prompt, /be honest that you are the shop's AI assistant/, 'never claims to be a person when sincerely asked');
  assert.match(prompt, /plus: Size \(S, M, L\), Colour\./);
  assert.match(prompt, /৳70 inside Dhaka \(1–2 days\), ৳130 outside Dhaka \(2–3 days\)\. Free delivery on orders over ৳3,000\. Cash on delivery is NOT available/);
  assert.match(prompt, /bKash 01812345678/);
  assert.match(prompt, /Location \/ pickup point: Mirpur 10, Dhaka/);
  assert.match(prompt, /Sells to: women\./);
});

test('the AI can be switched off for one channel', async () => {
  const s = await server();
  try {
    const channels = (await s.call('/channels', { token: s.token })).data;
    const whatsapp = channels.find((c) => c.platform === 'whatsapp');
    assert.equal(whatsapp.aiEnabled, true, 'on by default');
    assert.equal((await s.call(`/channels/${whatsapp.id}`, { method: 'PATCH', token: s.token, body: {} })).status, 400);
    assert.equal((await s.call('/channels/999', { method: 'PATCH', token: s.token, body: { aiEnabled: false } })).status, 404);
    const off = await s.call(`/channels/${whatsapp.id}`, { method: 'PATCH', token: s.token, body: { aiEnabled: false } });
    assert.equal(off.data.aiEnabled, false);

    await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { ai_mode: 'auto' } });
    const provider = fakeProvider();
    const inbox = createInbox(s.db, s.config);
    const agent = createAgent(s.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} } });
    const wa = await inbox.ingestMessage(inbound({ platform: 'whatsapp', channelExternalId: 'WA1', contactExternalId: '8801711111111', text: 'dam koto?' }));
    assert.equal(await agent.respond(wa.conversation.id, wa.message.id), 'channel_off');
    const fb = await inbox.ingestMessage(inbound({ text: 'dam koto?' }));
    assert.equal(await agent.respond(fb.conversation.id, fb.message.id), 'sent', 'other channels keep the AI');
    assert.equal(provider.calls.length, 1);
  } finally {
    await s.close();
  }
});

test('products import from a CSV file and a shared Google Sheet', async () => {
  const sheetCsv = 'Product,Price,Options,Stock\nGreen saree,"৩,২০০",,yes\n';
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.includes('PRIVATESHEET')) return new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } });
    return new Response(sheetCsv, { headers: { 'content-type': 'text/csv' } });
  };
  const s = await server({ fetchImpl });
  try {
    const imp = (body) => s.call('/products/import', { method: 'POST', token: s.token, body });
    const csv = 'Name,Price,Size,Description,Stock\n"Red kurti, cotton",৳1200,"M, L",Embroidered,yes\nBlue saree,2500,,,sold out\n,500\nBroken,abc\n';
    const res = await imp({ csv });
    assert.equal(res.status, 201);
    assert.equal(res.data.added, 2);
    assert.deepEqual(res.data.skipped.map((x) => x.line), [4, 5]);
    const products = (await s.call('/products', { token: s.token })).data;
    assert.deepEqual(products.map((p) => [p.name, p.price, p.variants, p.inStock]),
      [['Blue saree', 2500, '', false], ['Red kurti, cotton', 1200, 'M, L', true]]);

    assert.match((await imp({ csv: 'Colour,Size\nred,M\n' })).data.error, /"Name" and "Price"/);
    assert.match((await imp({ csv: '' })).data.error, /CSV file or paste/);
    assert.match((await imp({ sheetUrl: 'https://evil.test/spreadsheets/d/abc' })).data.error, /Google Sheets link/);
    assert.equal(fetched.length, 0, 'never fetches a non-Google link');

    const sheet = await imp({ sheetUrl: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/edit#gid=7' });
    assert.equal(sheet.data.added, 1);
    assert.equal(fetched[0], 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/export?format=csv&gid=7');
    assert.ok((await s.db.products.findOne({ name: 'Green saree' }).lean()).price === 3200, 'reads Bangla digits');

    const locked = await imp({ sheetUrl: 'https://docs.google.com/spreadsheets/d/PRIVATESHEETxxxxxxxxxxxxxx/edit' });
    assert.equal(locked.status, 400);
    assert.match(locked.data.error, /Anyone with the link/);
  } finally {
    await s.close();
  }
});

test('the CSV reader handles quotes, new lines and limits', () => {
  assert.deepEqual(parseCsv('a,b\n"x, ""y""","line\nbreak"\r\n'), [['a', 'b'], ['x, "y"', 'line\nbreak']]);
  const many = [['Name', 'Price'], ...Array.from({ length: 3 }, (_, i) => [`P${i}`, '10'])];
  const out = productsFromRows(many, { max: 2 });
  assert.equal(out.products.length, 2);
  assert.match(out.skipped[0].reason, /first 2/);
  assert.equal(googleSheetCsvUrl('http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456'), null, 'https only');
});

test('practice chat answers as the shop without storing or sending anything', async () => {
  const provider = fakeProvider(() => ({ reply: 'Ji, delivery charge Dhakar baire 130 taka.', handoff: false, handoff_reason: '', intent: 'delivery' }));
  const s = await server({ aiProvider: provider });
  try {
    await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { ai_name: 'Nusrat' } });
    const before = await s.db.messages.countDocuments();
    const res = await s.call('/ai/practice', {
      method: 'POST', token: s.token,
      body: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Ji bolun' }, { role: 'user', content: 'dhakar baire charge?' }] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { reply: 'Ji, delivery charge Dhakar baire 130 taka.', handoff: false, handoff_reason: '', intent: 'delivery' });
    assert.match(provider.calls[0].system, /You are Nusrat/);
    assert.deepEqual(provider.calls[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(await s.db.messages.countDocuments(), before, 'nothing stored');

    assert.equal((await s.call('/ai/practice', { method: 'POST', token: s.token, body: { messages: [{ role: 'assistant', content: 'hi' }] } })).status, 400);
    const mod = await s.call('/auth/login', { method: 'POST', body: { email: 'nadia@shop.test', password: 'password123' } });
    assert.equal((await s.call('/ai/practice', { method: 'POST', token: mod.data.token, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 403);
  } finally {
    await s.close();
  }
  const noAi = await server();
  try {
    const res = await noAi.call('/ai/practice', { method: 'POST', token: noAi.token, body: { messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(res.status, 503);
  } finally {
    await noAi.close();
  }
});

test('sign-up details are saved as a lead while typing, and linked when the account is created', async () => {
  const s = await server({ env: { ADMIN_TOKEN: 'secret-admin' } });
  try {
    const id = 'lead_abcdefghijklmnop';
    const save = (body) => s.call('/leads', { method: 'POST', body: { id, ...body } });
    assert.equal((await save({ name: 'Talha' })).status, 400, 'needs an email or a mobile number');
    assert.equal((await s.call('/leads', { method: 'POST', body: { id: 'bad', email: 'a@b.test' } })).status, 400);

    assert.equal((await save({ name: 'Talha', email: 'Talha@Nokshi.test', phone: '01712-345678', password: 'never-stored',
      survey: { team_size: '1_2', ad_spend: 'bogus' } })).status, 204);
    await save({ name: 'Talha Ahmed', businessName: 'Nokshi Threads', email: 'talha@nokshi.test', phone: '01712-345678' });
    const lead = await s.db.leads.findById(id).lean();
    assert.deepEqual({ name: lead.name, shop: lead.business_name, email: lead.email, phone: lead.phone },
      { name: 'Talha Ahmed', shop: 'Nokshi Threads', email: 'talha@nokshi.test', phone: '01712345678' });
    assert.ok(!JSON.stringify(lead).includes('never-stored'), 'the password is never stored');
    assert.equal(lead.converted_at, null);

    const signup = await s.call('/auth/signup', { method: 'POST', body: { leadId: id, businessName: 'Nokshi Threads', name: 'Talha Ahmed',
      email: 'talha@nokshi.test', password: 'password123', phone: '01712345678' } });
    assert.equal(signup.status, 201);
    const converted = await s.db.leads.findById(id).lean();
    assert.ok(converted.converted_at);
    assert.ok(converted.workspace_id);
    await save({ name: 'Someone else', email: 'x@y.test' });
    assert.equal((await s.db.leads.findById(id).lean()).name, 'Talha Ahmed', 'a signed-up lead is not overwritten by the form');

    // The follow-up list: password-protected spreadsheet.
    await s.call('/leads', { method: 'POST', body: { id: 'lead_qrstuvwxyz123456', name: '=HYPERLINK("x")', phone: '01811111111' } });
    const csv = (auth) => fetch(`${s.base}/admin/leads.csv`, { headers: auth ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {} });
    assert.equal((await csv()).status, 401);
    assert.equal((await csv('admin:wrong')).status, 401);
    const ok = await csv('admin:secret-admin');
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text.split('\n')[0], /^signed_up,name,shop,email,mobile/);
    assert.match(text, /yes,Talha Ahmed,Nokshi Threads,talha@nokshi\.test,01712345678/);
    assert.match(text, /no,"'=HYPERLINK\(""x""\)",,,01811111111/, 'formulas are neutralised');
  } finally {
    await s.close();
  }
  const off = await server();
  try {
    assert.equal((await fetch(`${off.base}/admin/leads.csv`)).status, 404, 'no admin token, no page');
  } finally {
    await off.close();
  }
});

test('the owner can go back to step 1 and change their sign-up details', async () => {
  const s = await server();
  try {
    const account = await s.call('/account', { token: s.token });
    assert.deepEqual({ ...account.data, survey: undefined }, { name: 'Owner', email: 'owner@shop.test', phone: '', businessName: 'Shop', survey: undefined });
    assert.equal((await s.call('/workspace', { method: 'PATCH', token: s.token, body: { onboardingStep: 'account' } })).status, 200);
    const bad = await s.call('/account', { method: 'PATCH', token: s.token, body: { email: 'nadia@shop.test' } });
    assert.equal(bad.status, 409, 'cannot take another user\'s email');
    assert.equal((await s.call('/account', { method: 'PATCH', token: s.token, body: { phone: '123' } })).status, 400);
    const saved = await s.call('/account', { method: 'PATCH', token: s.token,
      body: { name: 'Rupa', email: 'Rupa@Shop.test', phone: '01712-345678', businessName: 'Rupa Fashion', survey: { team_size: '3_plus' } } });
    assert.deepEqual({ ...saved.data, survey: saved.data.survey.team_size },
      { name: 'Rupa', email: 'rupa@shop.test', phone: '01712345678', businessName: 'Rupa Fashion', survey: '3_plus' });
    const login = await s.call('/auth/login', { method: 'POST', body: { email: 'rupa@shop.test', password: 'password123' } });
    assert.equal(login.status, 200, 'logs in with the new email');
    const mod = await s.call('/auth/login', { method: 'POST', body: { email: 'nadia@shop.test', password: 'password123' } });
    assert.equal((await s.call('/account', { token: mod.data.token })).status, 403);
  } finally {
    await s.close();
  }
});
