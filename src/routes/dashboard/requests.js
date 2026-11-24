import express, { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { createRequest, requestView, similarRequests } from '../../dashboard/requests.js';

const AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac'];

// UX-05 · Help → Requests.
export function requestRoutes(db, _config, { auth, agent }) {
  const router = Router();
  const langOf = async (req) => (['en', 'bn'].includes(req.query.lang) ? req.query.lang : (await db.users.findById(req.user.id, { language: 1 }).lean())?.language ?? 'en');

  // This shop's requests (asked or voted for), the most wanted first.
  router.get('/requests', auth, async (req, res) => {
    const lang = await langOf(req);
    const ws = req.user.workspace_id;
    const rows = await db.featureRequests.find({ voters: ws }).lean();
    // A request merged into another shows as the one it became.
    const into = await db.featureRequests.find({ _id: { $in: rows.filter((r) => r.merged_into).map((r) => r.merged_into) } }).lean();
    const all = new Map([...rows.filter((r) => !r.merged_into), ...into].map((r) => [r._id, r]));
    const order = { planned: 0, in_progress: 0, reviewing: 1, done: 2, not_now: 3 };
    const list = [...all.values()].map((r) => requestView(r, { workspaceId: ws, lang }))
      .sort((a, b) => (order[a.status] - order[b.status]) || b.votes - a.votes);
    res.json({ requests: list, voice: true, transcribe: Boolean(agent?.transcribe) });
  });

  router.get('/requests/similar', auth, async (req, res) => {
    const lang = await langOf(req);
    const rows = await similarRequests(db, req.user.workspace_id, String(req.query.q ?? '').slice(0, 300));
    res.json({ similar: rows.map((r) => requestView(r, { workspaceId: req.user.workspace_id, lang })) });
  });

  router.post('/requests', auth, async (req, res) => {
    const r = await createRequest(db, req.user, { text: req.body?.text, voice: req.body?.voice });
    res.status(201).json(requestView(await db.featureRequests.findById(r.id).lean(), { workspaceId: req.user.workspace_id, lang: await langOf(req) }));
  });

  // ▲ "We want this too".
  router.post('/requests/:id/vote', auth, async (req, res) => {
    const r = await db.featureRequests.findOneAndUpdate({ _id: Number(req.params.id), merged_into: null }, { $addToSet: { voters: req.user.workspace_id } }, { new: true, lean: true });
    if (!r) throw new InboxError(404, 'Request not found');
    res.json(requestView(r, { workspaceId: req.user.workspace_id, lang: await langOf(req) }));
  });

  router.delete('/requests/:id/vote', auth, async (req, res) => {
    const r = await db.featureRequests.findById(Number(req.params.id)).lean();
    if (!r) throw new InboxError(404, 'Request not found');
    if (r.workspace_id === req.user.workspace_id) throw new InboxError(409, 'You asked for this one, so your vote stays');
    const fresh = await db.featureRequests.findOneAndUpdate({ _id: r._id }, { $pull: { voters: req.user.workspace_id } }, { new: true, lean: true });
    res.json(requestView(fresh, { workspaceId: req.user.workspace_id, lang: await langOf(req) }));
  });

  // "Hold to speak": the voice note is kept with the request, and written out when the server can transcribe.
  router.post('/requests/voice', auth, express.raw({ type: AUDIO, limit: '10mb' }), async (req, res) => {
    const type = String(req.get('content-type') ?? '').split(';')[0];
    if (!AUDIO.includes(type) || !Buffer.isBuffer(req.body) || req.body.length < 500) throw new InboxError(400, 'Hold the button and speak');
    const id = randomBytes(12).toString('hex');
    await db.files.create({ _id: id, workspace_id: req.user.workspace_id, type, size: req.body.length, data: req.body, name: 'feature-request' });
    let text = '';
    if (agent?.transcribe) text = (await agent.transcribe(req.user.workspace_id, { bytes: req.body, mime: type }).catch(() => null))?.text ?? '';
    res.status(201).json({ voice: `/files/${id}`, text });
  });

  return router;
}
