import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { automatedWindow, messagingWindow } from '../src/platforms/meta.js';
import { setup, inbound } from './helpers.js';

const H = 3_600_000;

test('automated messages: 24 hours, then only Messenger order and booking updates with their own tag — never HUMAN_AGENT', () => {
  const now = Date.parse('2026-11-24T00:00:00Z');
  const ago = (h) => new Date(now - h * H).toISOString();
  assert.deepEqual(automatedWindow('messenger', ago(2), null, now), { ok: true, tag: null });
  assert.equal(automatedWindow('messenger', ago(30), null, now).ok, false, 'AI replies stop at 24 hours');
  assert.deepEqual(automatedWindow('messenger', ago(30), 'purchase', now), { ok: true, tag: 'POST_PURCHASE_UPDATE' });
  assert.deepEqual(automatedWindow('messenger', ago(30), 'event', now), { ok: true, tag: 'CONFIRMED_EVENT_UPDATE' });
  assert.equal(automatedWindow('instagram', ago(30), 'purchase', now).ok, false, 'Instagram has no update tags');
  assert.equal(automatedWindow('whatsapp', ago(30), 'event', now).ok, false, 'WhatsApp needs a template');
  assert.equal(automatedWindow('messenger', null, null, now).ok, false);
  // A teammate's own reply may still use the human-agent tag for 7 days.
  assert.deepEqual(messagingWindow('messenger', ago(30), now), { ok: true, tag: 'HUMAN_AGENT' });
});

test('the AI and the system never send with the human-agent tag; order and booking updates use theirs', async () => {
  const { db, config } = await setup({ env: { DRY_RUN: '0' } });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ message_id: `mid.out.${calls.length}` }) }; };
  const inbox = createInbox(db, { ...config, dryRun: false }, { fetchImpl });
  const c = (await inbox.ingestMessage(inbound({ timestamp: new Date(Date.now() - 30 * H).toISOString() }))).conversation;

  assert.equal(await inbox.sendAiReply(c.id, 'আর কিছু লাগবে?'), null, 'an AI reply after 24 hours is not sent');
  assert.equal(await inbox.sendAiRich(c.id, { kind: 'quick_replies', payload: { text: 'x', options: [{ title: 'M', value: 'M' }] }, text: 'x' }), null);
  assert.equal(calls.length, 0, 'nothing reached Meta');

  assert.ok(await inbox.purchaseUpdate(c.id, 'আপনার পার্সেল রওনা হয়েছে'));
  assert.deepEqual([calls[0].body.messaging_type, calls[0].body.tag], ['MESSAGE_TAG', 'POST_PURCHASE_UPDATE']);
  assert.ok(await inbox.eventUpdate(c.id, 'আগামীকাল আপনার বুকিং আছে'));
  assert.deepEqual([calls[1].body.messaging_type, calls[1].body.tag], ['MESSAGE_TAG', 'CONFIRMED_EVENT_UPDATE']);
  assert.ok(!calls.some((x) => x.body.tag === 'HUMAN_AGENT'));

  // Inside 24 hours: a plain response, no tag at all.
  const fresh = (await inbox.ingestMessage(inbound({ contactExternalId: 'fresh', text: 'hi' }))).conversation;
  assert.ok(await inbox.sendAiReply(fresh.id, 'জি বলুন'));
  assert.equal(calls.at(-1).body.tag, undefined);
});
