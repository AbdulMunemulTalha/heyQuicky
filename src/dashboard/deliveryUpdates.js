import { trackingUrl } from '../platforms/rich.js';
import { reviewRequest } from '../platforms/rich.js';
import { startChase } from './money.js';

// CRR-03 / CRR-05 / CRR-06: Settings → Delivery updates (frame "Delivery updates").
// Each step of a parcel's trip can send the customer a card with one button; the shop writes the
// title and message. Steps come from the courier's own status (picked up, out for delivery,
// delivery failed) and from the order (booked, delivered, returned). Each step goes once per order.
export const STEPS = ['booked', 'picked', 'out_for_delivery', 'delivered', 'returned', 'failed'];
export const BUTTONS = ['track', 'call_rider', 'bill'];
export const PLACEHOLDERS = ['name', 'order', 'tracking', 'eta', 'cod'];

export const DEFAULT_STEPS = {
  booked: { on: true, title: 'অর্ডার কুরিয়ারে বুক হয়েছে', message: '{name}, আপনার অর্ডার #{order} কুরিয়ারে বুক হয়েছে। ট্র্যাকিং নম্বর {tracking}।', button: 'track' },
  picked: { on: true, title: 'রাইডার পার্সেল নিয়েছেন', message: '{name}, অর্ডার #{order} রাইডার নিয়ে গেছেন। {eta}-এর মধ্যে পৌঁছে যাবে।', button: 'track' },
  out_for_delivery: { on: true, title: 'আজ ডেলিভারি হবে', message: '{name}, আজ আপনার পার্সেল পৌঁছাবে। ক্যাশ {cod} রেডি রাখুন 🙏', button: 'call_rider' },
  delivered: { on: true, title: 'পার্সেল ডেলিভারি হয়েছে', message: '{name}, অর্ডার #{order} পৌঁছে গেছে। কেনাকাটার জন্য ধন্যবাদ 💛', button: 'bill' },
  returned: { on: true, title: 'পার্সেল ফেরত এসেছে', message: '{name}, অর্ডার #{order} আমাদের কাছে ফেরত এসেছে। আবার পাঠাতে চাইলে জানাবেন।', button: 'bill' },
  failed: { on: false, title: 'ডেলিভারি করা যায়নি', message: '{name}, রাইডার আপনাকে পাননি। কবে পার্সেলটা নিতে পারবেন জানাবেন?', button: 'track' },
};
export const DEFAULT_ALERTS = { cancel_after_ship: true, handoff_failed: true };
export const DEFAULT_REVIEW = { on: true, coupon: '' };

// What a courier calls a status → our step (Steadfast and Pathao names, lower-cased).
const COURIER_STEP = {
  picked: 'picked', picked_up: 'picked', pickup_completed: 'picked', at_the_sorting_hub: 'picked', in_transit: 'picked', received_at_last_mile_hub: 'picked',
  out_for_delivery: 'out_for_delivery', assigned_for_delivery: 'out_for_delivery', on_the_way_to_delivery: 'out_for_delivery', delivering: 'out_for_delivery',
  hold: 'failed', delivery_failed: 'failed', failed_delivery: 'failed', customer_unreachable: 'failed', on_hold: 'failed',
};
export const stepForCourier = (status) => COURIER_STEP[String(status ?? '').toLowerCase().replace(/[\s-]+/g, '_')] ?? null;
// Order pipeline → step.
const PIPELINE_STEP = { in_transit: 'booked', delivered: 'delivered', returned: 'returned' };

// The shop's settings with defaults filled in. An older "delivery updates off" switch turns every step off.
export function deliverySettings(ws) {
  const s = ws?.settings ?? {};
  const allOff = s.delivery_updates === false && !s.delivery_steps;
  const steps = Object.fromEntries(STEPS.map((k) => {
    const saved = s.delivery_steps?.[k] ?? {};
    const d = DEFAULT_STEPS[k];
    return [k, { on: allOff ? false : (typeof saved.on === 'boolean' ? saved.on : d.on), title: saved.title || d.title, message: saved.message || d.message, button: BUTTONS.includes(saved.button) ? saved.button : d.button }];
  }));
  return {
    steps,
    alerts: { ...DEFAULT_ALERTS, ...(s.delivery_alerts ?? {}) },
    review: { ...DEFAULT_REVIEW, ...(s.delivery_review ?? {}) },
  };
}

const taka = (n) => `৳${Number(n || 0).toLocaleString('en-IN')}`;
function etaFor(ws, order) {
  if (order.area === 'outside_dhaka') return ws?.delivery_outside_days || '3-5 days';
  if (order.area === 'dhaka_suburbs') return ws?.settings?.suburbs_days || '2-3 days';
  return ws?.delivery_inside_days || '1-2 days';
}
const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0] || '';

export function fillMessage(template, order, ws) {
  const values = { name: firstName(order.customer_name), order: order.number ?? order._id ?? '', tracking: order.consignment_id || '—', eta: etaFor(ws, order), cod: taka(order.cod_amount) };
  return String(template ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

// The card the customer gets for one step.
export function stepCard(step, order, ws, { trackUrl = '', billUrl = '', riderPhone = '' } = {}) {
  const cfg = deliverySettings(ws).steps[step];
  const message = fillMessage(cfg.message, order, ws);
  let button = null;
  // "Call rider" needs the rider's number from the courier; until it is shared the card offers tracking.
  if (cfg.button === 'call_rider' && riderPhone) button = { type: 'phone', title: 'রাইডারকে কল করুন', value: riderPhone };
  else if (cfg.button === 'bill' && billUrl) button = { type: 'url', title: 'বিল দেখুন', value: billUrl };
  else if (trackUrl) button = { type: 'url', title: 'পার্সেল ট্র্যাক করুন', value: trackUrl };
  else if (billUrl) button = { type: 'url', title: 'বিল দেখুন', value: billUrl };
  const payload = {
    orderId: order._id, number: order.number ?? order._id, status: order.status, step, title: cfg.title, subtitle: message,
    courier: order.courier ?? '', tracking: order.consignment_id ?? '', buttons: button ? [button] : [],
  };
  return { kind: 'delivery_card', payload, text: [cfg.title, message, button?.type === 'url' ? button.value : button?.type === 'phone' ? `📞 ${button.value}` : ''].filter(Boolean).join('\n') };
}

export function createDeliveryUpdater(db, inbox, config, { log = console, notify = null } = {}) {
  const base = (config.publicUrl || '').replace(/\/+$/, '');
  async function already(order, step) {
    return db.orderEvents.exists({ order_id: order._id, type: 'delivery_update', to: step });
  }
  // Sends one step's card if the shop has it on and it wasn't sent for this order yet.
  async function sendStep(order, step) {
    if (!STEPS.includes(step) || !order.conversation_id) return 'skipped';
    const ws = await db.workspaces.findById(order.workspace_id).lean();
    const cfg = deliverySettings(ws);
    if (!cfg.steps[step].on) return 'off';
    if (await already(order, step)) return 'already';
    const fresh = await db.orders.findById(order._id).lean();
    if (!fresh) return 'gone';
    const consignment = await db.consignments.findOne({ order_id: fresh._id }).sort({ created_at: -1 }).lean();
    const card = stepCard(step, fresh, ws, {
      trackUrl: trackingUrl(fresh.courier, fresh.consignment_id), billUrl: fresh.bill_token && base ? `${base}/b/${fresh.bill_token}` : '', riderPhone: consignment?.rider_phone || '',
    });
    const sent = await inbox.purchaseRich(fresh.conversation_id, card);
    if (!sent) return 'window_closed';
    await db.insert(db.orderEvents, { workspace_id: fresh.workspace_id, order_id: fresh._id, type: 'delivery_update', to: step, by: 'ai', text: `Delivery update sent in chat (${step.replace(/_/g, ' ')})` });
    log.info?.(`delivery update ${step} sent for order ${fresh._id}`);
    return 'sent';
  }

  // "Hand to a person after a failed delivery": the AI asks for a new time and the chat is flagged.
  async function failedDelivery(order) {
    const ws = await db.workspaces.findById(order.workspace_id).lean();
    const cfg = deliverySettings(ws);
    const out = await sendStep(order, 'failed');
    if (!cfg.alerts.handoff_failed || !order.conversation_id) return out;
    if (await db.orderEvents.exists({ order_id: order._id, type: 'delivery_handoff' })) return out;
    if (out !== 'sent') await inbox.purchaseUpdate(order.conversation_id, fillMessage(DEFAULT_STEPS.failed.message, order, ws)).catch(() => null);
    await db.conversations.updateOne({ _id: order.conversation_id }, { $set: { ai_handoff: true, ai_handoff_reason: `Delivery failed for order #${order.number ?? order._id} — agree a new time with the customer`, ai_handoff_at: new Date() } });
    await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'delivery_handoff', by: 'ai', text: 'Delivery failed — the AI asked for a new time and handed the chat to the team' });
    await startChase(db, null, await db.orders.findById(order._id).lean(), { reason: 'Delivery failed — rider couldn\'t reach them' }).catch(() => null);
    await notify?.({ workspaceId: order.workspace_id, event: 'handoff', title: `Delivery failed: order #${order.number ?? order._id}`, body: `${order.customer_name} wasn't reached. The AI asked for a new time.`, link: `/inbox/${order.conversation_id}`, ref: `failed:${order._id}` });
    return out === 'sent' ? 'sent' : 'handed_off';
  }

  // Order moved along the pipeline (changeStatus).
  async function onStatus(order, from, to) {
    // CRR-05: a shipped order cancelled — tell the on-duty team at once so the parcel can be stopped.
    if (to === 'cancelled' && ['ready_to_ship', 'in_transit'].includes(from)) {
      const ws = await db.workspaces.findById(order.workspace_id).lean();
      if (deliverySettings(ws).alerts.cancel_after_ship) {
        await notify?.({ workspaceId: order.workspace_id, event: 'escalation', title: `Stop the parcel: order #${order.number ?? order._id} was cancelled`,
          body: `It was already ${from === 'in_transit' ? `with ${order.courier || 'the courier'}` : 'packed'}. Tell the courier not to deliver it.`, link: `/orders/${order.number ?? order._id}`, ref: `shipcancel:${order._id}` });
        return 'alerted';
      }
      return 'off';
    }
    const step = PIPELINE_STEP[to];
    return step ? sendStep(order, step) : 'skipped';
  }

  // The courier reported a new status (background sync or Refresh).
  async function onCourier(order, courierStatus) {
    const step = stepForCourier(courierStatus);
    if (!step) return 'skipped';
    return step === 'failed' ? failedDelivery(order) : sendStep(order, step);
  }

  // CRR-06: a day after delivery, ask for a rating (once per order).
  async function sendDueReviews(now = new Date()) {
    const due = await db.orderEvents.find({ type: 'status', to: 'delivered', created_at: { $lte: new Date(now - 86_400_000), $gte: new Date(now - 7 * 86_400_000) } }, { order_id: 1, workspace_id: 1 }).limit(500).lean();
    let sent = 0;
    for (const e of due) {
      if (await db.orderEvents.exists({ order_id: e.order_id, type: 'review_request' })) continue;
      const order = await db.orders.findById(e.order_id).lean();
      if (!order?.conversation_id || order.status !== 'delivered' || order.review?.rating) continue;
      const ws = await db.workspaces.findById(order.workspace_id).lean();
      if (!deliverySettings(ws).review.on) continue;
      const ok = await inbox.sendAiRich(order.conversation_id, reviewRequest(order)).catch(() => null);
      await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'review_request', by: 'ai', text: ok ? 'Asked the customer for a rating' : 'Rating request not sent (outside the messaging window)' });
      if (ok) sent += 1;
    }
    return sent;
  }

  return { onStatus, onCourier, sendStep, sendDueReviews };
}
