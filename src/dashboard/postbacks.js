import { changeStatus, NEXT } from './orderOps.js';
import { sizeChartMessage } from '../platforms/rich.js';
import { grantOffer, couponOffer } from './offers.js';

// What happens when a customer taps a button on a card (screen 24). Returns true when handled here,
// so the AI doesn't answer the same tap again. "Order this" (ORDER) is left to the AI / team as a normal message.
export function createPostbackHandler(db, inbox, { notify = null, emit = () => {}, publicUrl = '' } = {}) {
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
        const wsDoc = await db.workspaces.findById(ws, { 'settings.delivery_review': 1 }).lean();
        const code = stars >= 4 ? String(wsDoc?.settings?.delivery_review?.coupon ?? '').trim().toUpperCase() : '';
        const coupon = code ? await db.coupons.findOne({ workspace_id: ws, code, active: { $ne: false } }).lean() : null;
        if (coupon && order.customer_id) {
          await grantOffer(db, { workspaceId: ws, customerId: order.customer_id, conversationId, source: 'review', sourceId: order._id, ...couponOffer(coupon), endsAt: coupon.ends_at ?? new Date(Date.now() + 30 * 86_400_000) });
        }
        await inbox.sendAiReply(conversationId, coupon
          ? `অনেক ধন্যবাদ! 💛 পরের অর্ডারে ${coupon.code} কোডটা ব্যবহার করুন — ${coupon.type === 'percent' ? `${coupon.value}% ছাড়` : coupon.type === 'amount' ? `৳${coupon.value} ছাড়` : 'ফ্রি ডেলিভারি'}।`
          : 'অনেক ধন্যবাদ! আবার কেনাকাটা করলে জানাবেন 💛');
      }
      return true;
    }

    // BKG-04: the customer answers a quote card.
    if (action === 'QACCEPT' || action === 'QDECLINE') {
      const q = await db.quotes.findOne({ _id: Number(id), workspace_id: ws }).lean();
      if (!q || (q.conversation_id !== conv._id && q.customer_id !== conv.customer_id)) return false;
      if (q.status !== 'sent') { await inbox.sendAiReply(conversationId, q.status === 'accepted' ? 'এই কোটেশনটি আগেই গ্রহণ করেছেন 😊' : 'এই কোটেশনটি আর চালু নেই। নতুন দাম চাইলে জানাবেন।'); return true; }
      if (q.valid_until && q.valid_until < new Date()) {
        await db.quotes.updateOne({ _id: q._id }, { $set: { status: 'expired' } });
        await inbox.sendAiReply(conversationId, 'দুঃখিত, এই কোটেশনের মেয়াদ শেষ। নতুন দাম জানাতে বলছি।');
        await notify?.({ workspaceId: ws, event: 'handoff', title: `Quote Q-${q.number} expired`, body: `${q.name || 'The customer'} tried to accept it. Send a new price.`, link: '/bookings?tab=quotes', ref: `quote-exp:${q._id}` });
        return true;
      }
      const accepted = action === 'QACCEPT';
      await db.quotes.updateOne({ _id: q._id }, { $set: { status: accepted ? 'accepted' : 'declined', answered_at: new Date() } });
      const wsDoc = await db.workspaces.findById(ws, { bkash_number: 1, nagad_number: 1 }).lean();
      const pay = wsDoc?.bkash_number || wsDoc?.nagad_number;
      await inbox.sendAiReply(conversationId, accepted
        ? `ধন্যবাদ! 🎉 Q-${q.number} গ্রহণ করেছেন।${q.advance ? ` কাজ শুরু করতে ৳${q.advance.toLocaleString('en-IN')} অগ্রিম${pay ? ` ${wsDoc.bkash_number ? 'বিকাশ' : 'নগদ'} ${pay} নম্বরে` : ''} পাঠিয়ে TrxID দিন।` : ' আমাদের টিম শিগগিরই যোগাযোগ করবে।'}`
        : 'ঠিক আছে, জানানোর জন্য ধন্যবাদ। অন্য কিছু লাগলে বলবেন 😊');
      await notify?.({ workspaceId: ws, event: accepted ? 'order' : 'handoff', title: `${q.name || 'Customer'} ${accepted ? 'accepted' : 'declined'} quote Q-${q.number}`, body: `${q.title} · ৳${(q.price ?? 0).toLocaleString('en-IN')}`, link: '/bookings?tab=quotes', ref: `quote-ans:${q._id}` });
      return true;
    }

    if (action === 'SIZE') return sendSizeChart(db, inbox, conversationId, ws, Number(id), { publicUrl });

    if (action === 'NOTIFY') {
      const product = await db.products.findOneAndUpdate({ _id: Number(id), workspace_id: ws }, { $inc: { restock_waiting: 1 } }, { new: true, lean: true });
      if (!product) return false;
      await inbox.sendAiReply(conversationId, `ঠিক আছে! ${product.name} স্টকে এলেই আপনাকে জানাবো 🔔`);
      return true;
    }
    return false;
  };
}


// The product's size chart as text with size chips (from a "সাইজ চার্ট" tap or the AI). False when it has none.
export async function sendSizeChart(db, inbox, conversationId, workspaceId, productId, { publicUrl = '' } = {}) {
  const product = await db.products.findOne({ _id: productId, workspace_id: workspaceId }).lean();
  const chart = product?.size_chart_id ? await db.sizeCharts.findOne({ _id: product.size_chart_id, workspace_id: workspaceId }).lean() : null;
  if (!chart) return false;
  await inbox.sendAiRich(conversationId, sizeChartMessage(chart, { productName: product.name, publicUrl }));
  return true;
}
