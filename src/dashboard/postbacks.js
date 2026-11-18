import { changeStatus, NEXT } from './orderOps.js';
import { quickReplies } from '../platforms/rich.js';

// What happens when a customer taps a button on a card (screen 24). Returns true when handled here,
// so the AI doesn't answer the same tap again. "Order this" (ORDER) is left to the AI / team as a normal message.
export function createPostbackHandler(db, inbox, { notify = null, emit = () => {} } = {}) {
  return async (conversationId, _messageId, { action, id }) => {
    const conv = await db.conversations.findById(conversationId).lean();
    if (!conv) return false;
    const ws = conv.workspace_id;

    if (action === 'CONFIRM') {
      const order = await db.orders.findOne({ _id: Number(id), workspace_id: ws }).lean();
      // Only the customer's own order (same chat or same customer), and only while it waits for confirmation.
      if (!order || (order.conversation_id !== conv._id && order.customer_id !== conv.customer_id)) return false;
      const from = order.status === 'confirmed' ? 'pending' : order.status;
      if (from === 'pending' && NEXT.pending?.includes('approved')) {
        await changeStatus(db, null, order, 'approved', { emit, by: 'customer', text: 'Customer confirmed in chat' });
        await notify?.({ workspaceId: ws, event: 'order', title: `${order.customer_name} confirmed order #${order.number ?? order._id}`, body: 'Tapped "Yes, confirm" in chat. Ready to pack.', link: `/orders/${order.number ?? order._id}`, ref: `confirm:${order._id}` });
        await inbox.sendAiReply(conversationId, `ধন্যবাদ! অর্ডার #${order.number ?? order._id} কনফার্ম হয়েছে ✅ প্যাক হলেই জানাবো।`);
      } else {
        await inbox.sendAiReply(conversationId, `অর্ডার #${order.number ?? order._id} আগেই কনফার্ম করা আছে 😊`);
      }
      return true;
    }

    if (action === 'RATE') {
      const [orderId, stars] = String(id).split('-').map(Number);
      const order = await db.orders.findOne({ _id: orderId, workspace_id: ws }).lean();
      if (!order || !(stars >= 1 && stars <= 5)) return false;
      await db.orders.updateOne({ _id: order._id }, { $set: { review: { rating: stars, at: new Date() } } });
      await db.insert(db.orderEvents, { workspace_id: ws, order_id: order._id, type: 'note', by: 'customer', text: `Customer rated the order ${stars}/5` });
      if (stars <= 2) {
        await notify?.({ workspaceId: ws, event: 'handoff', title: `${order.customer_name} wasn't happy with order #${order.number ?? order._id}`, body: `Rated ${stars}/5. Reach out and make it right.`, link: `/inbox/${conversationId}`, ref: `rate:${order._id}` });
        await inbox.sendAiReply(conversationId, 'দুঃখিত 😞 আমাদের টিম এখনই আপনার সাথে কথা বলবে।');
      } else {
        await inbox.sendAiReply(conversationId, 'অনেক ধন্যবাদ! আবার কেনাকাটা করলে জানাবেন 💛');
      }
      return true;
    }

    if (action === 'SIZE') {
      const product = await db.products.findOne({ _id: Number(id), workspace_id: ws }).lean();
      const chart = product?.size_chart_id ? await db.sizeCharts.findById(product.size_chart_id).lean() : null;
      if (!chart) return false;
      const table = [chart.columns.join(' | '), ...chart.rows.map((r) => r.join(' | '))].join('\n');
      await inbox.sendAiRich(conversationId, quickReplies(`${product.name} — সাইজ চার্ট (${chart.unit === 'cm' ? 'সেমি' : 'ইঞ্চি'})\n${table}\n\nআপনার কোন সাইজ লাগবে?`,
        chart.rows.map((r) => r[0]).filter(Boolean).slice(0, 10)));
      return true;
    }

    if (action === 'NOTIFY') {
      const product = await db.products.findOneAndUpdate({ _id: Number(id), workspace_id: ws }, { $inc: { restock_waiting: 1 } }, { new: true, lean: true });
      if (!product) return false;
      await inbox.sendAiReply(conversationId, `ঠিক আছে! ${product.name} স্টকে এলেই আপনাকে জানাবো 🔔`);
      return true;
    }
    return false;
  };
}

