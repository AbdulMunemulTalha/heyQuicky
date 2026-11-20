import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { ACTIONS, DEFAULT_PERMISSIONS, permissionsFor } from '../../dashboard/permissions.js';
import { audit, dhakaDayStart } from '../../dashboard/util.js';
import { teamSettings, slaCounts, SHARE_MODES, RULE_FIELDS, RULE_ACTIONS, TOPICS } from '../../dashboard/team.js';
import { distributeUnassigned } from '../../assignment.js';

// Which actions each kind of rule allows: arriving chats are assigned; handoffs can also open a
// ticket or just notify; comments have no chat, so they notify.
const ACTIONS_FOR = { channel: ['assign'], tag: ['assign'], new_customer: ['assign'], topic: RULE_ACTIONS, order_over: RULE_ACTIONS, comment: ['notify'] };

const SHARE_ROLES = ['admin', 'moderator', 'agent'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// Phase 2 · Team (TEAM-02/04/05/06/07): members with their workload, the permissions grid,
// duty & reply targets, routing rules, and the audit log. Invites use /settings/team.
export function teamRoutes(db, _config, { auth, emit }) {
  const router = Router();
  const ownerOnly = (req, res, next) => (req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Only the owner can change this' }));
  const ownerOrAdmin = (req, res, next) => (['owner', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Only the owner or an admin can change this' }));

  router.get('/team', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const users = await db.users.find({ workspace_id: ws._id }, { name: 1, email: 1, role: 1, on_duty: 1, is_online: 1, is_active: 1, invite_pending: 1, last_seen_at: 1 }).sort({ role: 1, name: 1 }).lean();
    const ids = users.map((u) => u._id);
    const today = dhakaDayStart(new Date());
    const week = new Date(Date.now() - 7 * 86_400_000);
    const [open, replied, firstReplies, sla] = await Promise.all([
      db.conversations.aggregate([{ $match: { workspace_id: ws._id, status: 'open', assigned_user_id: { $in: ids } } }, { $group: { _id: '$assigned_user_id', n: { $sum: 1 } } }]),
      db.messages.aggregate([{ $match: { direction: 'out', sender_user_id: { $in: ids }, created_at: { $gte: today } } }, { $group: { _id: '$sender_user_id', n: { $sum: 1 } } }]),
      db.conversations.aggregate([{ $match: { workspace_id: ws._id, assigned_user_id: { $in: ids }, first_reply_at: { $gte: week } } },
        { $group: { _id: '$assigned_user_id', avg: { $avg: { $subtract: ['$first_reply_at', '$created_at'] } } } }]),
      slaCounts(db, ws),
    ]);
    const m = (rows) => new Map(rows.map((x) => [x._id, x]));
    const [o, r, f] = [m(open), m(replied), m(firstReplies)];
    const names = new Map(users.map((u) => [u._id, u.name]));
    const contacts = new Map((await db.contacts.find({ _id: { $in: sla.oldest.map((c) => c.contact_id) } }, { name: 1 }).lean()).map((c) => [c._id, c.name]));
    res.json({
      members: users.map((u) => ({
        id: u._id, name: u.name, email: u.email, role: u.role, active: u.is_active !== false, pending: Boolean(u.invite_pending), you: u._id === req.user.id,
        onDuty: u.is_active !== false && u.on_duty !== false && u.is_online !== false, openChats: o.get(u._id)?.n ?? 0, repliesToday: r.get(u._id)?.n ?? 0,
        firstReplyMin: f.get(u._id)?.avg != null ? Math.round(f.get(u._id).avg / 60_000) : null,
      })),
      sla: { waiting: sla.waiting, pastTarget: sla.pastTarget, neverAnswered: sla.neverAnswered, inHours: sla.inHours,
        oldest: sla.oldest.map((c) => ({ id: c._id, name: contacts.get(c.contact_id) ?? '', since: c.last_inbound_at, assignee: names.get(c.assigned_user_id) ?? '' })) },
      settings: teamSettings(ws), canEdit: ['owner', 'admin'].includes(req.user.role), isOwner: req.user.role === 'owner',
    });
  });

  router.patch('/team/settings', auth, ownerOrAdmin, async (req, res) => {
    const b = req.body ?? {};
    const set = {};
    const mins = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 1440) throw new InboxError(400, `${what} must be 1 to 1440 minutes`); return n; };
    if (b.share !== undefined) { if (!SHARE_MODES.includes(b.share)) throw new InboxError(400, 'Pick how chats are shared'); set['settings.team.share'] = b.share; }
    if (b.shareRoles !== undefined) {
      const roles = (Array.isArray(b.shareRoles) ? b.shareRoles : []).filter((x) => SHARE_ROLES.includes(x));
      if (!roles.length) throw new InboxError(400, 'Pick at least one role to share chats with');
      set['settings.team.share_roles'] = [...new Set(roles)];
    }
    if (b.replyMin !== undefined) set['settings.team.reply_min'] = mins(b.replyMin, 'The reply target');
    if (b.warnMin !== undefined) set['settings.team.warn_min'] = mins(b.warnMin, 'The owner warning');
    if (b.hours !== undefined) {
      const h = b.hours ?? {};
      const days = [...new Set((Array.isArray(h.days) ? h.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (h.on && !days.length) throw new InboxError(400, 'Pick at least one working day');
      if (!TIME.test(h.start ?? '') || !TIME.test(h.end ?? '')) throw new InboxError(400, 'Times look like 10:00');
      if (h.start === h.end) throw new InboxError(400, 'Start and end must differ');
      set['settings.team.hours'] = { on: Boolean(h.on), days, start: h.start, end: h.end };
    }
    if (b.rules !== undefined) {
      if (!Array.isArray(b.rules) || b.rules.length > 20) throw new InboxError(400, 'Up to 20 rules');
      const members = new Set((await db.users.find({ workspace_id: req.user.workspace_id, is_active: { $ne: false } }, { _id: 1 }).lean()).map((u) => u._id));
      set['settings.team.rules'] = b.rules.map((r) => {
        if (!RULE_FIELDS.includes(r?.field)) throw new InboxError(400, 'Unknown rule');
        if (!members.has(Number(r.userId))) throw new InboxError(400, 'Pick a teammate for every rule');
        const action = ACTIONS_FOR[r.field].includes(r.action) ? r.action : ACTIONS_FOR[r.field][0];
        let value = ['new_customer', 'comment'].includes(r.field) ? true : String(r.value ?? '').trim().slice(0, 40);
        if (r.field === 'channel' && !['messenger', 'instagram', 'whatsapp'].includes(value)) throw new InboxError(400, 'Pick a channel');
        if (r.field === 'tag' && !value) throw new InboxError(400, 'Enter the tag');
        if (r.field === 'topic' && !(value in TOPICS)) throw new InboxError(400, 'Pick a topic');
        if (r.field === 'order_over') { value = Number(String(value).replace(/\D/g, '')); if (!value) throw new InboxError(400, 'Enter the order amount'); }
        return { field: r.field, value, action, user_id: Number(r.userId) };
      });
    }
    if (typeof b.dutyOnly === 'boolean') set['settings.team.duty_only'] = b.dutyOnly;
    if (b.offDuty !== undefined) {
      const message = String(b.offDuty?.message ?? '').trim().slice(0, 300);
      if (b.offDuty?.on && !message) throw new InboxError(400, 'Write what the AI tells customers when nobody is on duty');
      set['settings.team.off_duty'] = { on: Boolean(b.offDuty?.on), message };
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    await audit(db, req.user, 'Changed team duty, targets or routing', { where: 'Team' });
    res.json({ settings: teamSettings(await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean()) });
  });

  // The owner (or an admin) switches a teammate on or off duty from Members.
  router.patch('/team/members/:id/duty', auth, ownerOrAdmin, async (req, res) => {
    if (typeof req.body?.onDuty !== 'boolean') throw new InboxError(400, 'Say on or off duty');
    const u = await db.users.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id, is_active: { $ne: false } }, { name: 1 }).lean();
    if (!u) throw new InboxError(404, 'Teammate not found');
    await db.users.updateOne({ _id: u._id }, { $set: { on_duty: req.body.onDuty, is_online: req.body.onDuty } });
    if (req.body.onDuty) await distributeUnassigned(db, req.user.workspace_id);
    await audit(db, req.user, `Put ${u.name} ${req.body.onDuty ? 'on' : 'off'} duty`, { where: 'Team' });
    emit(req.user.workspace_id, 'team', { userId: u._id, onDuty: req.body.onDuty });
    res.json({ onDuty: req.body.onDuty });
  });

  // Permissions grid (TEAM-02): ticks per role; the owner always has everything.
  router.get('/team/permissions', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean();
    res.json({ actions: Object.entries(ACTIONS).map(([key, label]) => ({ key, label })), roles: ['admin', 'moderator', 'agent'], grid: permissionsFor(ws), defaults: DEFAULT_PERMISSIONS, isOwner: req.user.role === 'owner' });
  });

  router.put('/team/permissions', auth, ownerOnly, async (req, res) => {
    const { role, action, value } = req.body ?? {};
    if (!['admin', 'moderator', 'agent'].includes(role) || !(action in ACTIONS) || typeof value !== 'boolean') throw new InboxError(400, 'Pick a role, a permission and on or off');
    if (req.body?.reset) {
      await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $unset: { 'settings.permissions': '' } });
    } else {
      await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: { [`settings.permissions.${role}.${action}`]: value } });
    }
    await audit(db, req.user, `${value ? 'Allowed' : 'Took away'} "${ACTIONS[action]}" for ${role}s`, { where: 'Team · Permissions' });
    emit(req.user.workspace_id, 'workspace', {});
    const ws = await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean();
    res.json({ grid: permissionsFor(ws) });
  });

  router.post('/team/permissions/reset', auth, ownerOnly, async (req, res) => {
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $unset: { 'settings.permissions': '' } });
    await audit(db, req.user, 'Reset permissions to the defaults', { where: 'Team · Permissions' });
    res.json({ grid: permissionsFor({}) });
  });

  // Audit log (TEAM-06): who changed what, filtered by person, area and period; CSV export.
  async function auditRows(req, limit) {
    const where = { workspace_id: req.user.workspace_id };
    const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    where.created_at = { $gte: new Date(Date.now() - days * 86_400_000) };
    if (req.query.user) where.user_id = Number(req.query.user);
    if (req.query.area) where.where = new RegExp(`^${String(req.query.area).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    return { rows: await db.audit.find(where).sort({ created_at: -1 }).limit(limit).lean(), days };
  }

  router.get('/team/audit', auth, ownerOrAdmin, async (req, res) => {
    const { rows, days } = await auditRows(req, 300);
    const areas = (await db.audit.distinct('where', { workspace_id: req.user.workspace_id })).filter(Boolean).map((a) => a.split(' · ')[0]);
    res.json({ days, entries: rows.map((a) => ({ id: a._id, at: a.created_at, actor: a.actor, userId: a.user_id, action: a.action, where: a.where })), areas: [...new Set(areas)].sort() });
  });

  router.get('/team/audit.csv', auth, ownerOrAdmin, async (req, res) => {
    const { rows } = await auditRows(req, 10_000);
    const lines = [['time', 'who', 'what', 'where'], ...rows.map((a) => [a.created_at.toISOString(), a.actor, a.action, a.where])];
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="audit-log.csv"').send(`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\n')}`);
  });

  return router;
}
