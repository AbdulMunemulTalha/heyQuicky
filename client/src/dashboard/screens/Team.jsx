import { useCallback, useEffect, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Avatar, Button, Card, Checkbox, Chips, Empty, ErrorState, Kpi, Modal, Pill, Skeleton, Tabs, Toggle, toast } from '../ui/kit.jsx';
import { InviteDialog } from './Settings.jsx';
import './team.css';

const TABS = ['members', 'permissions', 'duty', 'routing', 'audit'];
const DAYS = [6, 0, 1, 2, 3, 4, 5]; // Saturday first, as shops in Bangladesh plan the week
const REPLY_MINS = [5, 10, 15, 30, 60];
const WARN_MINS = [15, 30, 60, 120];
// One line under each role in the permissions grid (frame TeamPermissions).
// "22:00" → "10:00 PM" (or its Bangla form) for the working-hours summary.
const clock = (t, hhmm) => { const [h, m] = String(hhmm || '00:00').split(':').map(Number); return t.time(new Date(Date.UTC(2020, 0, 1, h - 6, m)).toISOString()); };
const ROLE_ORDER = ['owner', 'admin', 'moderator', 'agent'];
const ROLE_SUB = { owner: 'tm.roleSub.owner', admin: 'tm.roleSub.admin', moderator: 'tm.roleSub.moderator', agent: 'tm.roleSub.agent' };

// Phase 2 · Team (TEAM-01/02/04/05/06/07), laid out like frames TEAM-01…04.
export default function Team({ query, path }) {
  const t = useT();
  const { can } = useDash();
  const tab = path.endsWith('/audit') ? 'audit' : TABS.includes(query.tab) ? query.tab : 'members';
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [invite, setInvite] = useState(false);
  const [created, setCreated] = useState(null);
  const { socket } = useDash();
  const load = useCallback(() => dash('/team').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('team', load);
    return () => socket.off('team', load);
  }, [socket, load]);
  const go = (v) => (v === 'audit' ? navigate('/settings/audit') : navigate(`/settings/team${v === 'members' ? '' : `?tab=${v}`}`));
  if (error) return <ErrorState thing={t('tm.title')} error={error} onRetry={load} />;
  return (
    <div className="team">
      <header className="page-head">
        <div><h1>{t('tm.title')}</h1><p className="page-sub">{t('tm.sub')}</p></div>
        {can('invite') && <Button variant="primary" onClick={() => setInvite(true)}>{t('tm.inviteTeammate')}</Button>}
      </header>
      <Tabs label={t('tm.title')} value={tab} onChange={go} items={TABS.map((k) => ({ key: k, label: t(`tm.tab.${k}`) }))} />
      {!d ? <Skeleton h={300} r={12} /> : (
        <>
          {tab === 'members' && <Members t={t} d={d} onChange={load} />}
          {tab === 'permissions' && <Permissions t={t} />}
          {tab === 'duty' && <Duty t={t} d={d} onChange={load} />}
          {tab === 'routing' && <Routing t={t} d={d} onChange={load} />}
          {tab === 'audit' && <Audit t={t} d={d} query={query} />}
        </>
      )}
      {invite && <InviteDialog t={t} onClose={() => setInvite(false)} onDone={(r) => { setInvite(false); setCreated(r); load(); }} />}
      {created && (
        <Modal title={t('set.invited', { n: created.name })} onClose={() => setCreated(null)} width={440} footer={<Button variant="primary" onClick={() => setCreated(null)}>{t('common.done')}</Button>}>
          <p>{created.emailed ? t('set.invitedEmailed', { e: created.email }) : t('set.invitedShare')}</p>
          <div className="set-cred"><span>{created.email}</span><code>{created.password}</code></div>
          <p className="small muted">{t('set.invitedOnce')}</p>
        </Modal>
      )}
    </div>
  );
}

function statusPill(t, m) {
  if (!m.active) return <Pill tone="gray">{t('set.removed')}</Pill>;
  if (m.pending) return <Pill tone="yellow">{t('tm.inviteSent')}</Pill>;
  return m.onDuty ? <Pill tone="green">{t('tm.online')}</Pill> : <Pill tone="gray">{t('tm.offDutyPill')}</Pill>;
}

function Members({ t, d, onChange }) {
  const { can } = useDash();
  const canInvite = can('invite');
  async function patch(m, body, ok) {
    try { await dash(`/settings/team/${m.id}`, { method: 'PATCH', body }); toast(ok, 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
  }
  async function duty(m, onDuty) {
    try { await dash(`/team/members/${m.id}/duty`, { method: 'PATCH', body: { onDuty } }); toast(onDuty ? t('tm.nowOn', { n: m.name }) : t('tm.nowOff', { n: m.name }), 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
  }
  const target = d.settings.replyMin;
  return (
    <Card pad={false}>
      <div className="tm-tablewrap">
        <table className="tm-table tm-members">
          <thead><tr>
            <th scope="col">{t('tm.name')}</th><th scope="col">{t('tm.role')}</th><th scope="col">{t('tm.onDutyCol')}</th>
            <th scope="col">{t('tm.open')}</th><th scope="col">{t('tm.firstReply7')}</th><th scope="col">{t('tm.orders7')}</th><th scope="col"><span className="sr-only">{t('tm.status')}</span></th>
          </tr></thead>
          <tbody>
            {[...d.members].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)).map((m) => {
              const editable = canInvite && !m.you && m.role !== 'owner' && m.active;
              return (
                <tr key={m.id} className={m.active ? '' : 'off'}>
                  <td>
                    <span className="tm-who">
                      <Avatar name={m.name} size={30} />
                      <span><span><strong>{m.name}</strong>{m.you && <span className="muted"> · {t('set.you')}</span>}</span><small className="muted">{m.email}</small></span>
                    </span>
                  </td>
                  <td>
                    <select className="input input-sm tm-role" value={m.role} disabled={!editable} onChange={(e) => patch(m, { role: e.target.value }, t('common.saved'))} aria-label={t('set.roleFor', { n: m.name })}>
                      {(m.role === 'owner' ? ['owner'] : ['admin', 'moderator', 'agent']).map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
                    </select>
                  </td>
                  <td>
                    {m.active && !m.pending && (d.canEdit || m.you)
                      ? <Toggle size="sm" checked={m.onDuty} onChange={(on) => duty(m, on)} label={t('tm.dutyFor', { n: m.name })} />
                      : <Toggle size="sm" checked={m.onDuty && !m.pending} disabled label={t('tm.dutyFor', { n: m.name })} />}
                  </td>
                  <td>{t.num(m.openChats)}</td>
                  <td>{m.firstReplyMin == null ? <span className="muted">—</span> : <strong className={m.firstReplyMin > target ? 'tm-late' : ''}>{t('tm.minShort', { n: t.num(m.firstReplyMin) })}</strong>}</td>
                  <td>{t.num(m.ordersWeek ?? 0)}</td>
                  <td className="tm-actions">
                    {editable || (canInvite && !m.active && m.role !== 'owner') ? (
                      <Button size="sm" variant="ghost" className="tm-remove" onClick={() => patch(m, { active: !m.active }, m.active ? t('set.removedToast', { n: m.name }) : t('set.restored'))}>{m.active ? t('set.remove') : t('set.restore')}</Button>
                    ) : null}
                    {statusPill(t, m)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted tm-foot">{t('tm.dutyHint')}</p>
    </Card>
  );
}

function Permissions({ t }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash('/team/permissions').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('tm.tab.permissions')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={300} r={12} />;
  async function flip(role, action, value) {
    try { const r = await dash('/team/permissions', { method: 'PUT', body: { role, action, value } }); setD((x) => ({ ...x, grid: r.grid })); toast(t('common.saved'), 'green'); } catch (e) { toast(e.message, 'red'); }
  }
  async function reset() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('tm.resetConfirm'))) return;
    try { const r = await dash('/team/permissions/reset', { method: 'POST' }); setD((x) => ({ ...x, grid: r.grid })); toast(t('tm.resetDone'), 'green'); } catch (e) { toast(e.message, 'red'); }
  }
  const changed = (role, a) => d.grid[role][a] !== d.defaults[role][a];
  const head = (r) => <th key={r} scope="col" className="tm-rolehead">{t(`role.${r}`)}<small>{t(ROLE_SUB[r])}</small></th>;
  return (
    <>
      <Card pad={false}>
        <div className="tm-tablewrap">
          <table className="tm-table tm-perms">
            <thead><tr><th scope="col">{t('tm.whatTheyCan')}</th>{head('owner')}{d.roles.map(head)}</tr></thead>
            <tbody>
              {d.actions.map((a) => (
                <tr key={a.key}>
                  <th scope="row">{t(`perm.${a.key}`)}</th>
                  <td><input type="checkbox" className="tm-check" checked readOnly disabled aria-label={t('tm.always')} /></td>
                  {d.roles.map((r) => (
                    <td key={r} className={changed(r, a.key) ? 'tm-changed' : ''}>
                      <input type="checkbox" className="tm-check" checked={d.grid[r][a.key]} disabled={!d.isOwner} onChange={(e) => flip(r, a.key, e.target.checked)}
                        aria-label={t('tm.permFor', { p: t(`perm.${a.key}`), r: t(`role.${r}`) })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="small muted tm-under">
        {t(d.isOwner ? 'tm.permHint' : 'tm.permOwnerOnly')}
        {d.isOwner && <> · <button type="button" className="linklike" onClick={reset}>{t('tm.reset')}</button></>}
      </p>
    </>
  );
}

// Duty & SLA (frame TEAM-03): the counters, then the targets in one card.
function Duty({ t, d, onChange }) {
  const s = d.settings;
  const [f, setF] = useState({ replyMin: s.replyMin, warnMin: s.warnMin, hours: s.hours, dutyOnly: s.dutyOnly, offDuty: s.offDuty });
  const [busy, setBusy] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setH = (k, v) => setF((x) => ({ ...x, hours: { ...x.hours, [k]: v } }));
  async function save() {
    setBusy(true);
    try { await dash('/team/settings', { method: 'PATCH', body: f }); toast(t('common.saved'), 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
    setBusy(false);
  }
  const edit = d.canEdit;
  const oldest = d.sla.oldest[0];
  const opts = (list, cur) => [...new Set([...list, cur])].sort((a, b) => a - b);
  const hoursText = !f.hours.on ? t('tm.anyTime')
    : `${clock(t, f.hours.start)} – ${clock(t, f.hours.end)}, ${f.hours.days.length === 7 ? t('tm.everyDay') : DAYS.filter((x) => f.hours.days.includes(x)).map((x) => t(`tm.day.${x}`)).join(' ')}`;
  return (
    <div className="tm-duty-tab">
      <div className="tm-kpis">
        <Kpi label={t('tm.kWaiting')} value={t.num(d.sla.waiting)} tone={d.sla.waiting ? 'yellow' : 'green'}
          sub={oldest ? t('tm.oldest', { t: t.ago(oldest.since) }) : t('tm.nobodyWaiting')} onClick={oldest ? () => navigate(`/inbox/${oldest.id}`) : undefined} />
        <Kpi label={t('tm.kPastTarget', { n: t.num(s.replyMin) })} value={t.num(d.sla.pastTarget)} tone={d.sla.pastTarget ? 'red' : 'green'}
          sub={d.sla.pastTarget ? (d.sla.pastNames?.length ? d.sla.pastNames.join(', ') : t('tm.unassigned')) : t('tm.allOnTime')} />
        <Kpi label={t('tm.kNever7')} value={t.num(d.sla.neverAnswered)} tone={d.sla.neverAnswered ? 'red' : 'green'} sub={d.sla.neverAnswered ? t('tm.neverSub') : t('tm.keepZero')} />
      </div>
      <Card title={t('tm.targets')}>
        <div className="tm-targets">
          <label className="field"><span className="field-label">{t('tm.replyWithin')}</span>
            <select className="input" value={f.replyMin} onChange={(e) => set('replyMin', Number(e.target.value))} disabled={!edit}>
              {opts(REPLY_MINS, f.replyMin).map((n) => <option key={n} value={n}>{t('tm.minutes', { n: t.num(n) })}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">{t('tm.warnOwner')}</span>
            <select className="input" value={f.warnMin} onChange={(e) => set('warnMin', Number(e.target.value))} disabled={!edit}>
              {opts(WARN_MINS, f.warnMin).map((n) => <option key={n} value={n}>{t('tm.minutes', { n: t.num(n) })}</option>)}
            </select>
          </label>
          <div className="field"><span className="field-label">{t('tm.hours')}</span>
            <button type="button" className="input tm-hoursbtn" onClick={() => setHoursOpen((v) => !v)} aria-expanded={hoursOpen} disabled={!edit && !hoursOpen}>{hoursText}</button>
          </div>
        </div>
        {hoursOpen && (
          <div className="tm-hours">
            <Checkbox checked={f.hours.on} disabled={!edit} onChange={(v) => setH('on', v)} label={t('tm.hoursOn')} hint={t('tm.hoursHint')} />
            {f.hours.on && (
              <div className="tm-hoursrow">
                <div className="tm-days" role="group" aria-label={t('tm.days')}>
                  {DAYS.map((day) => (
                    <button key={day} type="button" className={`chip${f.hours.days.includes(day) ? ' on' : ''}`} aria-pressed={f.hours.days.includes(day)} disabled={!edit}
                      onClick={() => setH('days', f.hours.days.includes(day) ? f.hours.days.filter((x) => x !== day) : [...f.hours.days, day])}>{t(`tm.day.${day}`)}</button>
                  ))}
                </div>
                <span className="tm-times"><input className="input" type="time" value={f.hours.start} onChange={(e) => setH('start', e.target.value)} disabled={!edit} aria-label={t('tm.from')} /> – <input className="input" type="time" value={f.hours.end} onChange={(e) => setH('end', e.target.value)} disabled={!edit} aria-label={t('tm.to')} /></span>
                <Pill tone={d.sla.inHours ? 'green' : 'gray'}>{t(d.sla.inHours ? 'tm.nowOpen' : 'tm.nowClosed')}</Pill>
              </div>
            )}
          </div>
        )}
        <div className="tm-checks">
          <Checkbox checked={f.dutyOnly} disabled={!edit} onChange={(v) => set('dutyOnly', v)} label={t('tm.dutyOnly')} />
          <div className="tm-offduty">
            <Checkbox checked={f.offDuty.on} disabled={!edit} onChange={(v) => set('offDuty', { ...f.offDuty, on: v })} label={t('tm.offDutyTells')} />
            {f.offDuty.on && <input className="input" value={f.offDuty.message} onChange={(e) => set('offDuty', { ...f.offDuty, message: e.target.value })} maxLength={300} disabled={!edit} aria-label={t('tm.offDuty')} />}
          </div>
        </div>
        {edit && <div className="tm-save"><Button variant="primary" busy={busy} onClick={save}>{t('common.save')}</Button></div>}
      </Card>
    </div>
  );
}

const RULE_ACTIONS = { channel: ['assign'], tag: ['assign'], new_customer: ['assign'], topic: ['assign', 'assign_ticket', 'notify'], order_over: ['assign', 'assign_ticket', 'notify'], comment: ['notify'] };
const RULE_DEFAULT = { channel: 'messenger', tag: 'VIP', new_customer: true, topic: 'complaint', order_over: '10000', comment: true };

function ruleIf(t, r) {
  if (r.field === 'channel') return t('tm.sum.channel', { v: t(`ag.ch.${r.value}`) });
  if (r.field === 'tag') return t('tm.sum.tag', { v: r.value });
  if (r.field === 'topic') return t('tm.sum.topic', { v: t(`tm.topic.${r.value}`) });
  if (r.field === 'order_over') return t('tm.sum.order', { v: t.num(Number(r.value) || 0) });
  return t(`tm.rf.${r.field}`);
}

// Auto-assign (frame TEAM-04): how chats are shared, then the rules as IF … THEN … rows, each with Edit.
function Routing({ t, d, onChange }) {
  const s = d.settings;
  const [share, setShare] = useState(s.share);
  const [lastAuto, setLastAuto] = useState(s.share === 'queue' ? 'balanced' : s.share);
  const [shareRoles, setShareRoles] = useState(s.shareRoles);
  const [rules, setRules] = useState(s.rules.map((r) => ({ field: r.field, value: r.value, action: r.action ?? 'assign', userId: r.user_id })));
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const people = d.members.filter((m) => m.active && !m.pending);
  const name = (id) => people.find((m) => m.id === id)?.name ?? '—';
  const edit = d.canEdit;
  async function saveShare(body) {
    try { await dash('/team/settings', { method: 'PATCH', body }); toast(t('common.saved'), 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
  }
  function pick(mode) {
    setShare(mode);
    if (mode !== 'queue') setLastAuto(mode);
    saveShare({ share: mode });
  }
  async function saveRules(next) {
    setBusy(true);
    try { await dash('/team/settings', { method: 'PATCH', body: { rules: next } }); setRules(next); setEditing(null); toast(t('common.saved'), 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
    setBusy(false);
  }
  const setR = (i, patch) => setRules((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, dir) => setRules((list) => { const next = [...list]; const [x] = next.splice(i, 1); next.splice(i + dir, 0, x); return next; });
  const thenText = (r) => t(`tm.sumAct.${r.action}`, { n: name(r.userId) });
  return (
    <Card>
      <div className="tm-sharehead">
        <h3>{t('tm.shared')}</h3>
        <Toggle checked={share !== 'queue'} disabled={!edit} onChange={(on) => pick(on ? lastAuto : 'queue')} label={t('tm.autoShare')} />
      </div>
      <div className="tm-share" role="radiogroup" aria-label={t('tm.shared')}>
        {['round_robin', 'balanced', 'queue'].map((m) => (
          <button key={m} type="button" role="radio" aria-checked={share === m} className={`tm-opt${share === m ? ' on' : ''}`} disabled={!edit} onClick={() => pick(m)}>
            <strong>{t(`tm.share.${m}`)}</strong><small className="muted">{t(`tm.shareHint.${m}`)}</small>
          </button>
        ))}
      </div>
      {share !== 'queue' && (
        <div className="tm-sharewith">
          <span className="small muted">{t('tm.shareWith')}</span>
          <Chips label={t('tm.shareWith')} multi value={shareRoles} onChange={(v) => { if (edit && v.length) { setShareRoles(v); saveShare({ shareRoles: v }); } }} items={['admin', 'moderator', 'agent'].map((r) => ({ key: r, label: t(`role.${r}`) }))} />
        </div>
      )}
      <h3 className="tm-rulestitle">{t('tm.routingTitle')}</h3>
      {rules.length === 0 && editing == null ? <p className="small muted">{t('tm.noRulesSub')}</p> : (
        <ol className="tm-rules">
          {rules.map((r, i) => (editing === i ? (
            <li key={i} className="editing">
              <div className="tm-ruleedit">
                <span className="tm-if">{t('tm.if')}</span>
                <select className="input" value={r.field} onChange={(e) => { const k = e.target.value; setR(i, { field: k, value: RULE_DEFAULT[k], action: RULE_ACTIONS[k][0] }); }} aria-label={t('tm.ruleWhen')}>
                  {['channel', 'tag', 'new_customer', 'topic', 'order_over', 'comment'].map((k) => <option key={k} value={k}>{t(`tm.rf.${k}`)}</option>)}
                </select>
                {r.field === 'topic' && (
                  <select className="input" value={r.value} onChange={(e) => setR(i, { value: e.target.value })} aria-label={t('tm.ruleValue')}>
                    {['complaint', 'order_status', 'payment', 'delivery', 'new_order', 'price'].map((k) => <option key={k} value={k}>{t(`tm.topic.${k}`)}</option>)}
                  </select>
                )}
                {r.field === 'order_over' && <span className="tm-mins">৳<input className="input" inputMode="numeric" value={r.value} onChange={(e) => setR(i, { value: e.target.value.replace(/\D/g, '') })} aria-label={t('tm.ruleValue')} /></span>}
                {r.field === 'channel' && (
                  <select className="input" value={r.value} onChange={(e) => setR(i, { value: e.target.value })} aria-label={t('tm.ruleValue')}>
                    {['messenger', 'instagram', 'whatsapp'].map((p) => <option key={p} value={p}>{t(`ag.ch.${p}`)}</option>)}
                  </select>
                )}
                {r.field === 'tag' && <input className="input" value={r.value} onChange={(e) => setR(i, { value: e.target.value })} aria-label={t('tm.ruleValue')} maxLength={40} />}
                <span className="tm-if">{t('tm.then')}</span>
                <select className="input" value={r.action} onChange={(e) => setR(i, { action: e.target.value })} disabled={RULE_ACTIONS[r.field].length < 2} aria-label={t('tm.ruleAction')}>
                  {RULE_ACTIONS[r.field].map((a) => <option key={a} value={a}>{t(`tm.act.${a}`)}</option>)}
                </select>
                <select className="input" value={r.userId ?? ''} onChange={(e) => setR(i, { userId: Number(e.target.value) })} aria-label={t('tm.ruleWho')}>
                  {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div className="tm-ruleactions">
                <button type="button" className="sg-icon" disabled={i === 0} onClick={() => { move(i, -1); setEditing(i - 1); }} aria-label={t('tm.up')}>↑</button>
                <button type="button" className="sg-icon" disabled={i === rules.length - 1} onClick={() => { move(i, 1); setEditing(i + 1); }} aria-label={t('tm.down')}>↓</button>
                <Button size="sm" variant="ghost" onClick={() => saveRules(rules.filter((_, j) => j !== i))}>{t('tm.removeRule')}</Button>
                <Button size="sm" onClick={() => { setRules(s.rules.map((x) => ({ field: x.field, value: x.value, action: x.action ?? 'assign', userId: x.user_id }))); setEditing(null); }}>{t('common.cancel')}</Button>
                <Button size="sm" variant="primary" busy={busy} onClick={() => saveRules(rules)}>{t('common.save')}</Button>
              </div>
            </li>
          ) : (
            <li key={i}>
              <span className="tm-if">{t('tm.if')}</span>
              <span className="tm-cond">{ruleIf(t, r)}</span>
              <span className="tm-if">{t('tm.then')}</span>
              <span className="tm-then">{thenText(r)}</span>
              {edit && editing == null && <Button size="sm" className="tm-edit" onClick={() => setEditing(i)}>{t('common.edit')}</Button>}
            </li>
          )))}
        </ol>
      )}
      {edit && editing == null && rules.length < 20 && (
        <Button size="sm" onClick={() => { setRules([...rules, { field: 'channel', value: 'instagram', action: 'assign', userId: people[0]?.id }]); setEditing(rules.length); }}>{t('tm.addRule')}</Button>
      )}
      <p className="small muted tm-under">{t('tm.rulesOrder')}</p>
    </Card>
  );
}

function Audit({ t, d, query }) {
  const days = [1, 7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 7;
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);
  const qs = new URLSearchParams({ days: String(days), ...(query.user ? { user: query.user } : {}), ...(query.area ? { area: query.area } : {}) }).toString();
  const load = useCallback(() => dash(`/team/audit?${qs}`).then(setA, setError), [qs]);
  useEffect(() => { load(); }, [load]);
  async function exportCsv() {
    const res = await fetch(`/api/dash/team/audit.csv?${qs}`, { headers: { authorization: `Bearer ${session.token}` } });
    if (!res.ok) { toast(t('tm.exportFailed'), 'red'); return; }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a'); link.href = url; link.download = 'audit-log.csv'; link.click(); URL.revokeObjectURL(url);
  }
  if (!d.canEdit) return <Card><Empty icon="lock" title={t('tm.auditOwnerOnly')} /></Card>;
  if (error) return <ErrorState thing={t('tm.tab.audit')} error={error} onRetry={load} />;
  const today = new Date().toDateString();
  return (
    <Card pad={false}>
      <div className="tm-auditbar">
        <select className="input input-sm" value={query.user ?? ''} onChange={(e) => setQuery({ user: e.target.value || null })} aria-label={t('tm.who')}>
          <option value="">{t('tm.everyone')}</option>
          {d.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select className="input input-sm" value={query.area ?? ''} onChange={(e) => setQuery({ area: e.target.value || null })} aria-label={t('tm.area')}>
          <option value="">{t('tm.allChanges')}</option>
          {(a?.areas ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select className="input input-sm" value={String(days)} onChange={(e) => setQuery({ days: e.target.value === '7' ? null : e.target.value })} aria-label={t('tm.period')}>
          {[1, 7, 30, 90].map((n) => <option key={n} value={n}>{t('tm.lastDays', { n: t.num(n) })}</option>)}
        </select>
        <Button size="sm" className="tm-export" onClick={exportCsv}>{t('tm.export')}</Button>
      </div>
      {!a ? <div style={{ padding: 16 }}><Skeleton h={120} r={10} /></div> : a.entries.length === 0 ? <Empty icon="info" title={t('tm.auditEmpty')} /> : (
        <div className="tm-tablewrap">
          <table className="tm-table tm-audit">
            <thead><tr><th scope="col">{t('tm.when')}</th><th scope="col">{t('tm.who')}</th><th scope="col">{t('tm.whatChanged')}</th><th scope="col">{t('tm.where')}</th></tr></thead>
            <tbody>
              {a.entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted tm-when">{new Date(e.at).toDateString() === today ? t.time(e.at) : t.dateTime(e.at)}</td>
                  <td><span className="tm-who sm"><Avatar name={e.actor} size={22} /><span>{e.actor}</span></span></td>
                  <td className="bn-ok">{e.action}</td>
                  <td>{e.where && <Pill tone="gray">{e.where}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
