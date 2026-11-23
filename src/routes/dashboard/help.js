import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { ARTICLES, articleView, searchArticles } from '../../dashboard/helpArticles.js';

// The page a path belongs to, for "Popular on this page".
export function pageOf(path) {
  const p = String(path ?? '/');
  if (p.startsWith('/agent/training')) return 'training';
  if (p.startsWith('/saved-replies')) return 'saved';
  if (p.startsWith('/orders')) return 'orders';
  const first = p.split('/')[1] || 'overview';
  return { comments: 'inbox', bookings: 'customers' }[first] ?? first;
}

// Phase 2 · Help (UX-03) and "Stuck? We'll call you" (ONB-11), frame "Help videos & help bot".
export function helpRoutes(db, config, { auth, agent, adapters }) {
  const router = Router();
  const lastCall = new Map();

  router.get('/help', auth, async (req, res) => {
    const lang = req.query.lang === 'bn' ? 'bn' : 'en';
    const page = pageOf(req.query.path);
    const popular = ARTICLES.filter((a) => a.pages.includes(page));
    res.json({
      page, popular: (popular.length ? popular : ARTICLES.slice(0, 4)).slice(0, 4).map((a) => articleView(a, lang)),
      all: ARTICLES.map((a) => articleView(a, lang)),
      aiReady: Boolean(agent?.status().available),
      support: { phone: process.env.SUPPORT_PHONE || '', whatsapp: config.topup?.supportWhatsapp || process.env.SUPPORT_WHATSAPP || '', email: config.legal?.supportEmail || '' },
    });
  });

  // "Ask Quicky Help": answered from the help articles, with a link to the right page.
  router.post('/help/ask', auth, async (req, res) => {
    const question = String(req.body?.question ?? '').trim().slice(0, 300);
    const lang = req.body?.lang === 'bn' ? 'bn' : 'en';
    if (!question) throw new InboxError(400, 'Ask a question');
    const found = searchArticles(question, lang, 3);
    if (agent?.status().available) {
      try {
        const out = await agent.helpAnswer(question, (found.length ? found : ARTICLES).map((a) => articleView(a, lang)), lang);
        if (out?.answer) return res.json({ answer: out.answer, link: out.link || found[0]?.link || '', ai: true });
      } catch { /* fall back to the articles */ }
    }
    const best = found[0];
    res.json(best ? { answer: articleView(best, lang).body, link: best.link, title: articleView(best, lang).title, ai: false }
      : { answer: '', link: '', ai: false, none: true });
  });

  // "Stuck? We'll call you": the HeyQuicky team gets the shop's name and number by email.
  router.post('/help/callback', auth, async (req, res) => {
    const key = req.user.workspace_id;
    if (Date.now() - (lastCall.get(key) ?? 0) < 60 * 60_000) throw new InboxError(429, 'We already have your request — we\'ll call you soon');
    const phone = String(req.body?.phone ?? '').replace(/[^\d+]/g, '').slice(0, 16);
    if (phone.replace(/\D/g, '').length < 10) throw new InboxError(400, 'Enter the number we should call');
    const note = String(req.body?.note ?? '').trim().slice(0, 500);
    const ws = await db.workspaces.findById(req.user.workspace_id, { name: 1 }).lean();
    const to = config.legal?.supportEmail;
    if (to && adapters?.email) {
      await adapters.email.send({ to, subject: `Call request: ${ws?.name ?? 'a shop'}`, text: `${req.user.name} (${req.user.email}) at ${ws?.name ?? ''} asked for a call.\nPhone: ${phone}\nPage: ${req.body?.path ?? ''}\n\n${note}` });
    }
    lastCall.set(key, Date.now());
    res.json({ ok: true });
  });

  return router;
}
