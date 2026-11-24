import { Router, json } from 'express';
import { extensionZip, redeemConnectCode } from '../dashboard/extension.js';

// HND-05 public routes: the extension download (with this server's address inside) and turning a connect code into a session.
export function extensionPublicRoutes(db, config) {
  const router = Router();
  const tries = new Map(); // a few tries per minute per address, so codes can't be guessed

  router.get('/extension/heyquicky-extension.zip', (req, res) => {
    res.set('Content-Type', 'application/zip').set('Content-Disposition', 'attachment; filename="heyquicky-extension.zip"').set('Cache-Control', 'no-store');
    res.send(extensionZip(config.publicUrl || `${req.protocol}://${req.get('host')}`));
  });

  router.post('/api/ext/connect', json({ limit: '2kb' }), async (req, res) => {
    const key = req.ip;
    const now = Date.now();
    const t = (tries.get(key) ?? []).filter((x) => now - x < 60_000);
    if (t.length >= 10) return res.status(429).json({ error: 'Too many tries — wait a minute' });
    tries.set(key, [...t, now]);
    const r = await redeemConnectCode(db, req.body?.code);
    if (!r) return res.status(400).json({ error: 'That code is wrong or has expired — get a new one in HeyQuicky → Integrations' });
    const ws = await db.workspaces.findById(r.user.workspace_id, { name: 1 }).lean();
    res.json({ token: r.token, name: r.user.name, shop: ws?.name ?? '' });
  });

  return router;
}
