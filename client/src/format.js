export const PLATFORM_LABEL = { messenger: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp' };

export const STATUS_LABEL = {
  confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned',
};

export const taka = (n) => `৳${Number(n).toLocaleString('en-IN')}`;

// WhatsApp IDs are phone numbers: 8801711111111 -> +880 1711-111111.
export function formatPhone(waId) {
  const digits = String(waId).replace(/\D/g, '');
  const bd = /^880(1\d{3})(\d{6})$/.exec(digits);
  return bd ? `+880 ${bd[1]}-${bd[2]}` : `+${digits}`;
}

// How a customer is labelled in the list and chat header. Facebook and
// Instagram IDs mean nothing to people, so they are never shown.
export function customerLabel(c) {
  if (c.platform === 'whatsapp') {
    return { title: formatPhone(c.contact_external_id), subtitle: c.contact_name || '' };
  }
  return { title: c.contact_name || `${PLATFORM_LABEL[c.platform]} customer`, subtitle: '' };
}

export function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

export function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

// Meta only delivers replies within certain windows after the customer last wrote.
export function windowNotice(c) {
  if (!c.last_inbound_at) return 'The customer has not written yet, so Meta will not deliver a reply.';
  const hours = (Date.now() - new Date(c.last_inbound_at).getTime()) / 3_600_000;
  if (hours <= 24) return null;
  if (c.platform === 'whatsapp') return 'Over 24h since the customer wrote. WhatsApp only allows template messages now.';
  if (hours <= 24 * 7) return 'Over 24h since the customer wrote. Your reply is sent with the Human Agent tag (up to 7 days).';
  return 'Over 7 days since the customer wrote. Meta will not deliver a reply.';
}

// What happened to the conversations that existed before the channel was connected.
export function importLabel(c) {
  const count = `${c.conversationCount} conversation${c.conversationCount === 1 ? '' : 's'}`;
  switch (c.importStatus) {
    case 'running': return { className: 'muted', text: `Bringing in past chats… ${count} so far` };
    case 'done': return { className: 'ok-text', text: `Past chats brought in · ${count}` };
    case 'failed': return { className: 'warn', text: `Couldn't bring in past chats: ${c.importError}` };
    case 'declined': return { className: 'muted', text: 'Chat history was not shared (contacts only)' };
    default: return c.conversationCount ? { className: 'muted', text: count } : null;
  }
}
