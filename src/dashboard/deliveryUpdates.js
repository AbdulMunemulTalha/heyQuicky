import { deliveryUpdate, trackingUrl } from '../platforms/rich.js';

// CRR-04: when an order is packed, handed to the courier or delivered, the customer gets the
// delivery update card in their chat automatically. Shops can switch it off in
// Settings → Delivery & courier. Sent only while Meta's messaging window allows it.
export const UPDATE_STAGES = ['ready_to_ship', 'in_transit', 'delivered'];

export function createDeliveryUpdater(db, inbox, config, { log = console } = {}) {
  return async function sendDeliveryUpdate(order, from, to) {
    if (!UPDATE_STAGES.includes(to) || !order.conversation_id) return 'skipped';
    const ws = await db.workspaces.findById(order.workspace_id, { 'settings.delivery_updates': 1 }).lean();
    if (ws?.settings?.delivery_updates === false) return 'off';
    const fresh = await db.orders.findById(order._id).lean();
    if (!fresh) return 'gone';
    const billUrl = fresh.bill_token && config.publicUrl ? `${config.publicUrl.replace(/\/+$/, '')}/b/${fresh.bill_token}` : '';
    const sent = await inbox.sendAiRich(fresh.conversation_id, deliveryUpdate(fresh, { trackUrl: trackingUrl(fresh.courier, fresh.consignment_id), billUrl }));
    if (!sent) return 'window_closed';
    await db.insert(db.orderEvents, { workspace_id: fresh.workspace_id, order_id: fresh._id, type: 'note', by: 'ai', text: `Delivery update sent in chat (${to.replace(/_/g, ' ')})` });
    log.info?.(`delivery update sent for order ${fresh._id}`);
    return 'sent';
  };
}
