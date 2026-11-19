import { useCallback, useEffect, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Card, Chips, Empty, ErrorState, Kpi, Modal, Pill, Skeleton, Tabs, Toggle, toast } from '../ui/kit.jsx';
import { InviteDialog, ROLE_HINT } from './Settings.jsx';
import './team.css';

const TABS = ['members', 'permissions', 'duty', 'routing', 'audit'];
const DAYS = [6, 0, 1, 2, 3, 4, 5]; // Saturday first, as shops in Bangladesh plan the week

// Phase 2 · Team (TEAM-01/02/04/05/06/07).
export default function Team({ query, path }) {
  const t = useT();
  const tab = path.endsWith('/audit') ? 'audit' : TABS.includes(query.tab) ? query.tab : 'members';
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
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
      </header>
      {d && (
        <div className="tm-kpis">
          <Kpi label={t('tm.kOnDuty')} value={`${t.num(d.members.filter((m) => m.onDuty).length)} / ${t.num(d.members.filter((m) => m.active && !m.pending).length)}`} />
          <Kpi label={t('tm.kWaiting')} value={t.num(d.sla.waiting)} tone={d.sla.waiting ? 'yellow' : undefined} />
          <Kpi label={t('tm.kPast', { n: t.num(d.settings.replyMin) })} value={t.num(d.sla.pastTarget)} tone={d.sla.pastTarget ? 'red' : undefined} onClick={d.sla.oldest[0] ? () => navigate(`/inbox/${d.sla.oldest[0].id}`) : undefined} />
          <Kpi label={t('tm.kNever')} value={t.num(d.sla.neverAnswered)} />
        </div>
      )}
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
    </div>
  );
}

function Members({ t, d, onChange }) {
  const { can } = useDash();
  const [invite, setInvite] = useState(false);
  const [created, setCreated] = useState(null);
  async function patch(m, body, ok) {
    try { await dash(`/settings/team/${m.id}`, { method: 'PATCH', body }); toast(ok, 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
  }
  const canInvite = can('invite');
  return (
    <Card pad={false} title={t('tm.members')} action={canInvite && <Button variant="primary" size="sm" onClick={() => setInvite(true)}>{t('tm.invite')}</Button>}>
      <div className="tm-tablewrap">
        <table className="tm-table">
          <thead><tr>
            <th scope="col">{t('tm.person')}</th><th scope="col">{t('tm.role')}</th><th scope="col">{t('tm.duty')}</th>
            <th scope="col">{t('tm.open')}</th><th scope="col">{t('tm.replies')}</th><th scope="col">{t('tm.firstReply')}</th><th scope="col"><span className="sr-only">{t('cp.actions')}</span></th>
          </tr></thead>
          <tbody>
            {d.members.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'off'}>
                <td><strong>{m.name}</strong>{m.you && <span className="muted"> · {t('set.you')}</span>}<br /><small className="muted">{m.email}</small></td>
                <td>
                  {canInvite && !m.you && m.role !== 'owner' && m.active ? (
                    <select className="input input-sm" value={m.role} onChange={(e) => patch(m, { role: e.target.value }, t('common.saved'))} aria-label={t('set.roleFor', { n: m.name })}>
                      {['admin', 'moderator', 'agent'].map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
                    </select>
                  ) : <span>{t(`role.${m.role}`)}</span>}
                  <br /><small className="muted">{t(ROLE_HINT[m.role])}</small>
                </td>
                <td>{!m.active ? <Pill tone="gray">{t('set.removed')}</Pill> : m.pending ? <Pill tone="blue">{t('tm.pending')}</Pill> : <Pill tone={m.onDuty ? 'green' : 'gray'}>{m.onDuty ? t('set.onDuty') : t('set.away')}</Pill>}</td>
                <td>{t.num(m.openChats)}</td>
                <td>{t.num(m.repliesToday)}</td>
                <td>{m.firstReplyMin == null ? <span className="muted">—</span> : t('tm.minutes', { n: t.num(m.firstReplyMin) })}</td>
                <td className="tm-actions">
                  {canInvite && !m.you && m.role !== 'owner' && (
                    <Button size="sm" variant="ghost" onClick={() => patch(m, { active: !m.active }, m.active ? t('set.removedToast', { n: m.name }) : t('set.restored'))}>{m.active ? t('set.remove') : t('set.restore')}</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted tm-foot">{t('tm.dutyHint')}</p>
      {invite && <InviteDialog t={t} onClose={() => setInvite(false)} onDone={(r) => { setInvite(false); setCreated(r); onChange(); }} />}
      {created && (
        <Modal title={t('set.invited', { n: created.name })} onClose={() => setCreated(null)} width={440} footer={<Button variant="primary" onClick={() => setCreated(null)}>{t('common.done')}</Button>}>
          <p>{created.emailed ? t('set.invitedEmailed', { e: created.email }) : t('set.invitedShare')}</p>
          <div className="set-cred"><span>{created.email}</span><code>{created.password}</code></div>
          <p className="small muted">{t('set.invitedOnce')}</p>
        </Modal>
      )}
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
  return (
    <Card pad={false} title={t('tm.permTitle')} action={d.isOwner && <Button size="sm" variant="ghost" onClick={reset}>{t('tm.reset')}</Button>}>
      <div className="tm-tablewrap">
        <table className="tm-table tm-perms">
          <thead><tr><th scope="col">{t('tm.can')}</th><th scope="col">{t('role.owner')}</th>{d.roles.map((r) => <th key={r} scope="col">{t(`role.${r}`)}</th>)}</tr></thead>
          <tbody>
            {d.actions.map((a) => (
              <tr key={a.key}>
                <th scope="row">{t(`perm.${a.key}`)}</th>
                <td><span className="tm-tick" aria-label={t('tm.always')}>✓</span></td>
                {d.roles.map((r) => (
                  <td key={r} className={changed(r, a.key) ? 'tm-changed' : ''}>
                    <Toggle size="sm" checked={d.grid[r][a.key]} disabled={!d.isOwner} onChange={(v) => flip(r, a.key, v)} label={t('tm.permFor', { p: t(`perm.${a.key}`), r: t(`role.${r}`) })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted tm-foot">{t(d.isOwner ? 'tm.permHint' : 'tm.permOwnerOnly')}</p>
    </Card>
  );
}

function Duty({ t, d, onChange }) {
  const s = d.settings;
  const [f, setF] = useState({ share: s.share, shareRoles: s.shareRoles, replyMin: String(s.replyMin), warnMin: String(s.warnMin), hours: s.hours });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setH = (k, v) => setF((x) => ({ ...x, hours: { ...x.hours, [k]: v } }));
  async function save() {
    setBusy(true);
    try { await dash('/team/settings', { method: 'PATCH', body: { ...f, replyMin: Number(f.replyMin), warnMin: Number(f.warnMin) } }); toast(t('common.saved'), 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
    setBusy(false);
  }
  const edit = d.canEdit;
  return (
    <div className="tm-cols">
      <Card title={t('tm.targets')}>
        <label className="tm-row"><span>{t('tm.replyWithin')}</span><span className="tm-mins"><input className="input" inputMode="numeric" value={f.replyMin} onChange={(e) => set('replyMin', e.target.value.replace(/\D/g, ''))} disabled={!edit} /> {t('tm.min')}</span></label>
        <label className="tm-row"><span>{t('tm.warnAfter')}</span><span className="tm-mins"><input className="input" inputMode="numeric" value={f.warnMin} onChange={(e) => set('warnMin', e.target.value.replace(/\D/g, ''))} disabled={!edit} /> {t('tm.min')}</span></label>
        <p className="small muted">{t('tm.targetsHint')}</p>
        {d.sla.oldest.length > 0 && (
          <div className="tm-waiting">
            <span className="small muted">{t('tm.longest')}</span>
            {d.sla.oldest.map((c) => (
              <button key={c.id} type="button" className="tm-wait" onClick={() => navigate(`/inbox/${c.id}`)}>
                <strong className="small">{c.name || '—'}</strong><small className="muted">{t.ago(c.since)}{c.assignee ? ` · ${c.assignee}` : ` · ${t('tm.unassigned')}`}</small>
              </button>
            ))}
          </div>
        )}
      </Card>
      <Card title={t('tm.hours')}>
        <div className="tm-row"><span>{t('tm.hoursOn')}</span><Toggle checked={f.hours.on} disabled={!edit} onChange={(v) => setH('on', v)} label={t('tm.hoursOn')} /></div>
        {f.hours.on && (
          <>
            <div className="tm-days" role="group" aria-label={t('tm.days')}>
              {DAYS.map((day) => (
                <button key={day} type="button" className={`chip${f.hours.days.includes(day) ? ' on' : ''}`} aria-pressed={f.hours.days.includes(day)} disabled={!edit}
                  onClick={() => setH('days', f.hours.days.includes(day) ? f.hours.days.filter((x) => x !== day) : [...f.hours.days, day])}>{t(`tm.day.${day}`)}</button>
              ))}
            </div>
            <div className="tm-row"><span>{t('tm.from')}</span><span className="tm-times"><input className="input" type="time" value={f.hours.start} onChange={(e) => setH('start', e.target.value)} disabled={!edit} /> – <input className="input" type="time" value={f.hours.end} onChange={(e) => setH('end', e.target.value)} disabled={!edit} /></span></div>
          </>
        )}
        <p className="small muted">{t('tm.hoursHint')}</p>
        <Pill tone={d.sla.inHours ? 'green' : 'gray'}>{t(d.sla.inHours ? 'tm.nowOpen' : 'tm.nowClosed')}</Pill>
      </Card>
      <Card title={t('tm.shared')}>
        <fieldset className="tm-share">
          {['balanced', 'queue'].map((m) => (
            <label key={m} className={`tm-opt${f.share === m ? ' on' : ''}`}>
              <input type="radio" name="share" checked={f.share === m} onChange={() => set('share', m)} disabled={!edit} />
              <span><strong>{t(`tm.share.${m}`)}</strong><small className="muted">{t(`tm.shareHint.${m}`)}</small></span>
            </label>
          ))}
        </fieldset>
        {f.share === 'balanced' && (
          <>
            <span className="small"><strong>{t('tm.shareWith')}</strong></span>
            <Chips label={t('tm.shareWith')} multi value={f.shareRoles} onChange={(v) => edit && v.length && set('shareRoles', v)} items={['admin', 'moderator', 'agent'].map((r) => ({ key: r, label: t(`role.${r}`) }))} />
          </>
        )}
        <p className="small muted">{t('tm.dutyAlerts')}</p>
      </Card>
      {edit && <div className="tm-save"><Button variant="primary" busy={busy} onClick={save}>{t('common.save')}</Button></div>}
    </div>
  );
}

function Routing({ t, d, onChange }) {
  const [rules, setRules] = useState(d.settings.rules.map((r) => ({ field: r.field, value: r.value, userId: r.user_id })));
  const [busy, setBusy] = useState(false);
  const people = d.members.filter((m) => m.active && !m.pending);
  const setR = (i, patch) => setRules((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function save() {
    setBusy(true);
    try { await dash('/team/settings', { method: 'PATCH', body: { rules } }); toast(t('common.saved'), 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
    setBusy(false);
  }
  const move = (i, dir) => setRules((list) => { const next = [...list]; const [x] = next.splice(i, 1); next.splice(i + dir, 0, x); return next; });
  return (
    <Card title={t('tm.routingTitle')} action={d.canEdit && <Button size="sm" disabled={rules.length >= 20} onClick={() => setRules([...rules, { field: 'channel', value: 'instagram', userId: people[0]?.id }])}>{t('tm.addRule')}</Button>}>
      <p className="small muted">{t('tm.routingHint')}</p>
      {rules.length === 0 ? <Empty icon="customers" title={t('tm.noRules')}>{t('tm.noRulesSub')}</Empty> : (
        <ol className="tm-rules">
          {rules.map((r, i) => (
            <li key={i}>
              <span className="tm-if">{t('tm.if')}</span>
              <select className="input" value={r.field} onChange={(e) => setR(i, { field: e.target.value, value: e.target.value === 'channel' ? 'messenger' : e.target.value === 'tag' ? 'VIP' : true })} disabled={!d.canEdit} aria-label={t('tm.ruleWhen')}>
                {['channel', 'tag', 'new_customer'].map((k) => <option key={k} value={k}>{t(`tm.rf.${k}`)}</option>)}
              </select>
              {r.field === 'channel' && (
                <select className="input" value={r.value} onChange={(e) => setR(i, { value: e.target.value })} disabled={!d.canEdit} aria-label={t('tm.ruleValue')}>
                  {['messenger', 'instagram', 'whatsapp'].map((p) => <option key={p} value={p}>{t(`ag.ch.${p}`)}</option>)}
                </select>
              )}
              {r.field === 'tag' && <input className="input" value={r.value} onChange={(e) => setR(i, { value: e.target.value })} disabled={!d.canEdit} aria-label={t('tm.ruleValue')} maxLength={40} />}
              <span className="tm-if">{t('tm.then')}</span>
              <select className="input" value={r.userId ?? ''} onChange={(e) => setR(i, { userId: Number(e.target.value) })} disabled={!d.canEdit} aria-label={t('tm.ruleWho')}>
                {people.map((m) => <option key={m.id} value={m.id}>{t('tm.assignTo', { n: m.name })}</option>)}
              </select>
              {d.canEdit && (
                <span className="tm-ruleactions">
                  <button type="button" className="sg-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('tm.up')}>↑</button>
                  <button type="button" className="sg-icon" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label={t('tm.down')}>↓</button>
                  <button type="button" className="sg-icon" onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label={t('tm.removeRule')}>×</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="small muted">{t('tm.rulesOrder')}</p>
      {d.canEdit && <div className="tm-save"><Button variant="primary" busy={busy} onClick={save}>{t('common.save')}</Button></div>}
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
  return (
    <Card pad={false} title={t('tm.auditTitle')} action={<Button size="sm" onClick={exportCsv}>{t('tm.export')}</Button>}>
      <div className="tm-auditbar">
        <select className="input" value={query.user ?? ''} onChange={(e) => setQuery({ user: e.target.value || null })} aria-label={t('tm.who')}>
          <option value="">{t('tm.everyone')}</option>
          {d.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select className="input" value={query.area ?? ''} onChange={(e) => setQuery({ area: e.target.value || null })} aria-label={t('tm.area')}>
          <option value="">{t('tm.allChanges')}</option>
          {(a?.areas ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select className="input" value={String(days)} onChange={(e) => setQuery({ days: e.target.value === '7' ? null : e.target.value })} aria-label={t('tm.period')}>
          {[1, 7, 30, 90].map((n) => <option key={n} value={n}>{t('tm.lastDays', { n: t.num(n) })}</option>)}
        </select>
      </div>
      {!a ? <div style={{ padding: 16 }}><Skeleton h={120} r={10} /></div> : a.entries.length === 0 ? <Empty icon="info" title={t('tm.auditEmpty')} /> : (
        <ul className="tm-audit">
          {a.entries.map((e) => (
            <li key={e.id}>
              <time className="small muted">{t.dateTime(e.at)}</time>
              <span><strong className="small">{e.actor}</strong> <span className="small bn-ok">{e.action}</span></span>
              {e.where && <Pill tone="gray">{e.where}</Pill>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
