import { graphRequest } from '../platforms/meta.js';
import { decryptSecret } from '../secrets.js';

// Button taps on Messenger / Instagram cards (screen 24) only reach our webhook when each Page is
// subscribed to messaging_postbacks. The connect flow (frozen, onboarding) subscribes Pages to
// messages and message echoes; this adds postbacks for Pages already connected and new ones, without
// touching that code. Instagram accounts are covered by their Page's subscription.
// "feed" brings the Page's comments (CMT-01); Instagram comments come through the app's instagram "comments" field.
export const PAGE_FIELDS = 'messages,message_echoes,messaging_postbacks,feed';

export async function subscribePagesToPostbacks(db, config, { fetchImpl = globalThis.fetch, log = console } = {}) {
  if (config.dryRun) return { pages: 0, skipped: 'dry_run' };
  const channels = await db.channels.find({
    platform: { $in: ['messenger', 'instagram'] }, page_id: { $ne: null }, access_token: { $ne: '' },
    needs_reconnect: { $ne: true }, $or: [{ postbacks_subscribed_at: null }, { page_fields: { $ne: PAGE_FIELDS } }],
  }).lean();
  const byPage = new Map();
  for (const c of channels) if (!byPage.has(c.page_id)) byPage.set(c.page_id, c);
  let done = 0;
  for (const [pageId, c] of byPage) {
    try {
      const token = decryptSecret(c.access_token, config.tokenKey);
      const data = await graphRequest(`https://graph.facebook.com/${config.meta.graphVersion}/${pageId}/subscribed_apps`, {
        method: 'POST', accessToken: token, body: { subscribed_fields: PAGE_FIELDS }, fetchImpl,
      });
      if (data?.success === false) throw new Error('Facebook refused the subscription');
      await db.channels.updateMany({ page_id: pageId, platform: { $in: ['messenger', 'instagram'] } }, { $set: { postbacks_subscribed_at: new Date(), page_fields: PAGE_FIELDS } });
      done += 1;
    } catch (err) {
      // Left unmarked, so the next run tries again (e.g. after the shop reconnects the Page).
      log.warn?.(`page ${pageId}: could not subscribe to postbacks — ${err.message}`);
    }
  }
  return { pages: done, of: byPage.size };
}

// Runs at start and every 10 minutes, so a Page connected later is picked up too.
export function startPageSubscriptions(db, config, { everyMs = 10 * 60_000, fetchImpl } = {}) {
  const run = () => subscribePagesToPostbacks(db, config, { fetchImpl })
    .then((r) => { if (r.pages) console.log(`Subscribed ${r.pages} Page(s) to button taps (postbacks).`); })
    .catch((err) => console.warn('postback subscription run failed:', err.message));
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
