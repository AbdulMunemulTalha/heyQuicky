import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Avatar, Button, Card, Empty, ErrorState, Modal, Pill, Segmented, Skeleton, toast } from '../ui/kit.jsx';
import './segments.css';

const COLOURS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple'];
const DOTS = ['green', 'blue', 'purple', 'yellow', 'red', 'orange', 'gray'];
const TEMPLATES = {
  repeat: [{ field: 'orders', op: 'gte', value: 2 }],
  big: [{ field: 'spent', op: 'gte', value: 10000 }],
  lapsed: [{ field: 'orders', op: 'gte', value: 1 }, { field: 'active_days', op: 'gte', value: 60 }],
  risky: [{ field: 'risk', op: 'is', value: 'high' }],
};

// Phase 2 · Tags & segments (CRM-03 / CRM-04), frame "Tags, segments": the segments and tags on
// the left; the chosen segment's conditions (edited in place) and its customers on the right.
export default function Segments({ query }) {
  const t = useT();
  const { can } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null); // a new, unsaved segment
  const load = useCallback(() => dash('/segments').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('sg.title')} error={error} onRetry={load} />;
  const edit = can('reply');
  const chosen = draft ?? d?.segments.find((s) => String(s.id) === String(query.segment)) ?? d?.segments[0] ?? null;
  const pick = (s) => { setDraft(null); setQuery({ segment: s.id }); };
  const startNew = (name = '', conditions = [{ field: 'orders', op: 'gte', value: 2 }]) => setDraft({ name, conditions });
  return (
    <div className="segments">
      <button type="button" className="sg-back" onClick={() => navigate('/customers')}>← {t('nav.customers')}</button>
      <header className="page-head">
        <div><h1>{t('sg.title')}</h1><p className="page-sub">{t('sg.sub')}</p></div>
        <div className="page-actions">{edit && <Button variant="primary" onClick={() => startNew()}>{t('sg.new')}</Button>}</div>
      </header>
      {!d ? <Skeleton h={320} r={12} /> : (
        <div className="sg-layout">
          <div className="sg-left">
            <Card pad={false}>
              <h3 className="sg-cardtitle">{t('sg.segments')}</h3>
              {d.segments.length === 0 && !draft ? (
                <div className="sg-empty">
                  <p className="small muted">{t('sg.emptySub')}</p>
                  {edit && <div className="sg-templates">{Object.keys(TEMPLATES).map((k) => <Button key={k} size="sm" onClick={() => startNew(t(`sg.tpl.${k}`), TEMPLATES[k])}>{t(`sg.tpl.${k}`)}</Button>)}</div>}
                </div>
              ) : (
                <ul className="sg-list">
                  {draft && (
                    <li><button type="button" className="sg-item on"><span className="sg-dot dot-gray" /><span className="sg-name"><strong>{draft.name || t('sg.newTitle')}</strong><small className="muted">{t('sg.unsaved')}</small></span></button></li>
                  )}
                  {d.segments.map((s, i) => (
                    <li key={s.id}>
                      <button type="button" className={`sg-item${!draft && chosen?.id === s.id ? ' on' : ''}`} onClick={() => pick(s)} aria-current={!draft && chosen?.id === s.id}>
                        <span className={`sg-dot dot-${DOTS[i % DOTS.length]}`} />
                        <span className="sg-name"><strong className="bn-ok">{s.name}</strong><small className="muted">{summary(t, s.conditions)}</small></span>
                        <strong className="sg-n">{t.num(s.count)}</strong>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Tags t={t} d={d} edit={edit} onChange={load} />
          </div>
          {chosen ? (
            <Editor key={draft ? 'new' : chosen.id} t={t} seg={chosen} fields={d.fields ?? {}} tags={d.tags ?? []} edit={edit}
              onSaved={(id) => { setDraft(null); load(); if (id) setQuery({ segment: id }); }} onDiscard={() => setDraft(null)} onDeleted={() => { setQuery({ segment: null }); load(); }} />
          ) : <Card><Empty icon="customers" title={t('sg.empty')}>{t('sg.emptySub')}</Empty></Card>}
        </div>
      )}
    </div>
  );
}

function describe(t, c) {
  const v = c.field === 'risk' ? t(`sg.risk.${c.value}`) : c.field === 'vip' ? t(c.value ? 'sg.yes' : 'sg.no') : c.field === 'spent' ? t.money(c.value) : c.field === 'delivery_rate' ? t.pct(c.value) : c.value;
  return t(`sg.desc.${c.field}.${c.op}`, { v });
}
// "Auto · 3+ orders, 90%+ delivered"; a segment that is just one tag reads "Manual tag".
function summary(t, conds) {
  if (conds.length === 1 && conds[0].field === 'tag') return t('sg.manualTag');
  return `${t('sg.auto')} · ${conds.map((c) => describe(t, c)).join(', ')}`;
}

function Tags({ t, d, edit, onChange }) {
  const [name, setName] = useState('');
  const [manage, setManage] = useState(false);
  async function add(e) {
    e.preventDefault();
    try { await dash('/tags', { method: 'POST', body: { name } }); setName(''); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  async function patch(tag, body) {
    try { await dash(`/tags/${encodeURIComponent(tag.name)}`, { method: 'PATCH', body }); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  async function rename(tag) {
    // eslint-disable-next-line no-alert
    const to = window.prompt(t('sg.renamePrompt'), tag.name);
    if (to && to !== tag.name) patch(tag, { name: to });
  }
  async function remove(tag) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('sg.tagDeleteConfirm', { tag: tag.name, n: tag.count }))) return;
    try { await dash(`/tags/${encodeURIComponent(tag.name)}`, { method: 'DELETE' }); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  const chip = (key, label, tone, count, title) => <Pill key={key} tone={tone} className="sg-chip" title={title}>{label} · {t.num(count)}</Pill>;
  return (
    <Card pad={false}>
      <div className="sg-cardtitle sg-tagshead">
        <h3>{t('sg.tags')}</h3>
        {edit && <button type="button" className="linklike small" onClick={() => setManage((v) => !v)} aria-expanded={manage}>{t(manage ? 'common.done' : 'sg.manage')}</button>}
      </div>
      <div className="sg-tagsbody">
        <div className="sg-chips">
          {d.autoTags.map((a) => chip(a.key, t(`sg.auto.${a.key}`), a.key === 'high_risk' ? 'red' : a.key === 'vip' ? 'green' : 'blue', a.count, t('sg.autoTags')))}
          {d.aiTags.map((a) => chip(`ai-${a.key}`, t(`sg.ai.${a.key}`), 'yellow', a.count, t('sg.aiTags')))}
          {d.tags.map((tag) => chip(`m-${tag.name}`, tag.name, tag.colour, tag.count, t('sg.manualTags')))}
        </div>
        <p className="small muted">{t('sg.tagsNote')}</p>
        {manage && (
          <div className="sg-manage">
            <span className="small muted">{t('sg.manualTags')}</span>
            {d.tags.length === 0 ? <p className="small muted">{t('sg.noTags')}</p> : (
              <ul className="sg-tags">
                {d.tags.map((tag) => (
                  <li key={tag.name}>
                    <Pill tone={tag.colour}>{tag.name}</Pill>
                    <span className="grow" />
                    <select className="input sg-colour" value={tag.colour} onChange={(e) => patch(tag, { colour: e.target.value })} aria-label={t('sg.colour', { tag: tag.name })}>
                      {COLOURS.map((c) => <option key={c} value={c}>{t(`sg.c.${c}`)}</option>)}
                    </select>
                    <button type="button" className="sg-icon" onClick={() => rename(tag)} aria-label={t('sg.rename', { tag: tag.name })}>✎</button>
                    <button type="button" className="sg-icon" onClick={() => remove(tag)} aria-label={t('sg.deleteTag', { tag: tag.name })}>×</button>
                  </li>
                ))}
              </ul>
            )}
            <form className="sg-addtag" onSubmit={add}>
              <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sg.tagPlaceholder')} aria-label={t('sg.newTag')} maxLength={30} />
              <Button type="submit" size="sm" disabled={!name.trim()}>{t('sg.addTag')}</Button>
            </form>
            <p className="small muted">{t('sg.riskHint')}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

// The chosen segment: its name and conditions edited in place, then its customers.
function Editor({ t, seg, fields, tags, edit, onSaved, onDiscard, onDeleted }) {
  const [name, setName] = useState(seg.name);
  const [conds, setConds] = useState(seg.conditions.map((c) => ({ ...c })));
  const [preview, setPreview] = useState(null);
  const [members, setMembers] = useState(null);
  const [busy, setBusy] = useState(false);
  const [coupon, setCoupon] = useState(false);
  const [more, setMore] = useState(false);
  const dirty = !seg.id || name !== seg.name || JSON.stringify(conds) !== JSON.stringify(seg.conditions);
  useEffect(() => {
    if (!dirty) { setPreview(null); return undefined; }
    const timer = setTimeout(() => dash('/segments/preview', { method: 'POST', body: { conditions: conds } }).then(setPreview, (err) => setPreview({ error: err.message })), 350);
    return () => clearTimeout(timer);
  }, [conds, dirty]);
  const loadMembers = useCallback(() => { if (seg.id) dash(`/segments/${seg.id}/customers`).then(setMembers).catch((err) => toast(err.message, 'red')); }, [seg.id]);
  useEffect(() => { loadMembers(); }, [loadMembers, seg.count]);
  const setC = (i, patch) => setConds((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const defaults = { orders: 2, spent: 5000, returned: 1, active_days: 30, tag: tags[0]?.name ?? 'VIP', vip: true, risk: 'high', area: 'Dhaka', delivery_rate: 90 };
  async function save() {
    setBusy(true);
    try {
      if (seg.id) { await dash(`/segments/${seg.id}`, { method: 'PATCH', body: { name, conditions: conds } }); toast(t('common.saved'), 'green'); onSaved(); }
      else { const r = await dash('/segments', { method: 'POST', body: { name, conditions: conds } }); toast(t('common.saved'), 'green'); onSaved(r.id); }
    } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  function discard() {
    if (!seg.id) { onDiscard(); return; }
    setName(seg.name); setConds(seg.conditions.map((c) => ({ ...c })));
  }
  async function tagAll() {
    setMore(false);
    // eslint-disable-next-line no-alert
    const tag = window.prompt(t('sg.tagPrompt', { n: seg.count }));
    if (!tag) return;
    try { const r = await dash(`/segments/${seg.id}/tag`, { method: 'POST', body: { tag } }); toast(t('sg.tagged', { n: t.num(r.tagged), tag }), 'green'); onSaved(); } catch (err) { toast(err.message, 'red'); }
  }
  async function remove() {
    setMore(false);
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('sg.deleteConfirm', { name: seg.name }))) return;
    try { await dash(`/segments/${seg.id}`, { method: 'DELETE' }); onDeleted(); } catch (err) { toast(err.message, 'red'); }
  }
  const count = dirty && preview && !preview.error ? preview.count : seg.count;
  return (
    <div className="sg-right">
      <Card>
        <div className="sg-edhead">
          <div className="sg-edtitle">
            {edit ? <input className="sg-namein" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sg.namePlaceholder')} aria-label={t('sg.name')} maxLength={60} autoFocus={!seg.id} />
              : <h2>{seg.name}</h2>}
            <small className="muted">{count == null ? '…' : t('sg.countLive', { n: t.num(count) })}</small>
          </div>
          {seg.id && edit && (
            <div className="sg-edactions">
              <Button size="sm" onClick={() => navigate(`/growth?tab=broadcasts&segment=${seg.id}`)}>{t('sg.broadcast')}</Button>
              <Button size="sm" onClick={() => setCoupon(true)}>{t('sg.coupon')}</Button>
              <span className="sg-more">
                <button type="button" className="sg-icon" onClick={() => setMore((v) => !v)} aria-expanded={more} aria-label={t('sg.moreActions')}>⋯</button>
                {more && (
                  <span className="sg-menu" role="menu">
                    <button type="button" role="menuitem" onClick={tagAll}>{t('sg.tagAll')}</button>
                    <button type="button" role="menuitem" className="danger" onClick={remove}>{t('common.delete')}</button>
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
        <div className="sg-conds">
          {conds.map((c, i) => {
            const f = fields[c.field] ?? { ops: [], type: 'number' };
            return (
              <div key={i} className="sg-cond">
                <span className="sg-where">{t(i === 0 ? 'sg.where' : 'sg.and')}</span>
                <select className="input" value={c.field} disabled={!edit} onChange={(e) => { const k = e.target.value; setC(i, { field: k, op: fields[k].ops[0], value: defaults[k] }); }} aria-label={t('sg.field')}>
                  {Object.keys(fields).map((k) => <option key={k} value={k}>{t(`sg.f.${k}`)}</option>)}
                </select>
                <select className="input" value={c.op} disabled={!edit} onChange={(e) => setC(i, { op: e.target.value })} aria-label={t('sg.op')}>
                  {f.ops.map((o) => <option key={o} value={o}>{t(`sg.op.${o}`)}</option>)}
                </select>
                {f.type === 'risk' ? (
                  <select className="input" value={c.value} disabled={!edit} onChange={(e) => setC(i, { value: e.target.value })} aria-label={t('sg.value')}>{['low', 'medium', 'high'].map((r) => <option key={r} value={r}>{t(`sg.risk.${r}`)}</option>)}</select>
                ) : f.type === 'bool' ? (
                  <select className="input" value={String(c.value)} disabled={!edit} onChange={(e) => setC(i, { value: e.target.value === 'true' })} aria-label={t('sg.value')}><option value="true">{t('sg.yes')}</option><option value="false">{t('sg.no')}</option></select>
                ) : c.field === 'tag' ? (
                  <input className="input" list="sg-taglist" value={c.value} disabled={!edit} onChange={(e) => setC(i, { value: e.target.value })} aria-label={t('sg.value')} />
                ) : (
                  <span className="sg-valwrap">
                    <input className="input" inputMode={f.type === 'number' ? 'numeric' : 'text'} value={c.value} disabled={!edit} onChange={(e) => setC(i, { value: f.type === 'number' ? e.target.value.replace(/\D/g, '') : e.target.value })} aria-label={t('sg.value')} />
                    {c.field === 'delivery_rate' && <span className="sg-unit">%</span>}
                  </span>
                )}
                {edit && <button type="button" className="sg-x" disabled={conds.length < 2} onClick={() => setConds(conds.filter((_, j) => j !== i))} aria-label={t('sg.removeCond')}>×</button>}
              </div>
            );
          })}
          <datalist id="sg-taglist">{[...tags.map((x) => x.name), 'VIP', 'Repeat buyer', 'First order', 'Big spender', 'Returned before', 'High COD risk', 'Asked for discount', 'Gift buyer', 'Wholesale enquiry'].map((n) => <option key={n} value={n} />)}</datalist>
        </div>
        {edit && (
          <div className="sg-edfoot">
            <Button size="sm" disabled={conds.length >= 8} onClick={() => setConds([...conds, { field: 'orders', op: 'gte', value: 1 }])}>{t('sg.addCond')}</Button>
            {preview?.error && <span className="small sg-err">{preview.error}</span>}
            {dirty && (
              <span className="sg-savebar">
                <Button size="sm" variant="ghost" onClick={discard}>{t(seg.id ? 'sg.discard' : 'common.cancel')}</Button>
                <Button size="sm" variant="primary" busy={busy} disabled={!name.trim() || !conds.length || Boolean(preview?.error)} onClick={save}>{t(seg.id ? 'common.save' : 'sg.create')}</Button>
              </span>
            )}
          </div>
        )}
      </Card>
      <Card pad={false}>
        {dirty ? (
          <div className="sg-previewnote small muted">{preview && !preview.error ? <>{t('sg.matches', { n: t.num(preview.count) })}{preview.sample.length > 0 && ` · ${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''}`}</> : '…'}<br />{t('sg.saveToSee')}</div>
        ) : !members ? <div style={{ padding: 16 }}><Skeleton h={160} r={10} /></div> : members.customers.length === 0 ? <Empty icon="customers" title={t('sg.noMembers')} /> : (
          <div className="sg-tablewrap">
            <table className="sg-table">
              <thead><tr>
                <th scope="col">{t('sg.colCustomer')}</th><th scope="col">{t('sg.f.orders')}</th><th scope="col">{t('sg.colSpent')}</th>
                <th scope="col">{t('sg.f.delivery_rate')}</th><th scope="col">{t('sg.colRisk')}</th><th scope="col">{t('sg.colSuggested')}</th>
              </tr></thead>
              <tbody>
                {members.customers.map((c) => (
                  <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                    <td><span className="sg-who"><Avatar name={c.name || '?'} size={28} /><span><strong>{c.name || '—'}</strong><small className="muted">{c.phone}</small></span></span></td>
                    <td>{t.num(c.orders)}</td>
                    <td>{t.money(c.spent)}</td>
                    <td>{c.deliveryRate == null ? <span className="muted">—</span> : (
                      <span className="sg-rate"><span className="sg-bar" aria-hidden="true"><span className={c.deliveryRate >= 85 ? 'good' : c.deliveryRate >= 60 ? 'mid' : 'low'} style={{ width: `${c.deliveryRate}%` }} /></span>{t.pct(c.deliveryRate)}</span>
                    )}</td>
                    <td><Pill tone={c.risk === 'high' ? 'red' : c.risk === 'medium' ? 'yellow' : 'green'}>{t(`sg.riskShort.${c.risk}`)}</Pill></td>
                    <td className="sg-sugg">{c.suggested ? t(`sg.sug.${c.suggested.key}`, { n: c.suggested.amount ? t.money(c.suggested.amount) : '', code: c.suggested.code ?? '' }) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {members.count > members.customers.length && <p className="small muted sg-showing">{t('sg.showing', { n: t.num(members.customers.length), of: t.num(members.count) })}</p>}
          </div>
        )}
      </Card>
      {coupon && <GiveCoupon t={t} seg={seg} onClose={() => setCoupon(false)} />}
    </div>
  );
}

function GiveCoupon({ t, seg, onClose }) {
  const [f, setF] = useState({ code: '', type: 'percent', value: '10', endsAt: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { dash(`/coupons/generate?prefix=${encodeURIComponent(seg.name.split(' ')[0])}`).then((r) => setF((x) => ({ ...x, code: r.code }))).catch(() => {}); }, [seg.name]);
  async function create() {
    setBusy(true);
    try {
      await dash('/coupons', { method: 'POST', body: { code: f.code, type: f.type, value: f.type === 'free_delivery' ? 0 : Number(f.value), audience: 'segment', segmentId: seg.id, aiMayMention: false, endsAt: f.endsAt ? `${f.endsAt}T23:59:59+06:00` : null } });
      toast(t('sg.couponMade', { code: f.code, name: seg.name }), 'green'); onClose();
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={t('sg.couponTitle', { name: seg.name })} subtitle={t('sg.couponSub', { n: t.num(seg.count) })} onClose={onClose} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={f.code.length < 3 || (f.type !== 'free_delivery' && !Number(f.value))} onClick={create}>{t('cp.create')}</Button></>
    )}>
      <div className="sg-form">
        <label className="small"><strong>{t('cp.code')}</strong><input className="input sg-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} maxLength={20} /></label>
        <Segmented label={t('cp.discount')} value={f.type} onChange={(v) => setF({ ...f, type: v })} items={[{ key: 'percent', label: t('cp.tPercent') }, { key: 'amount', label: t('cp.tAmount') }, { key: 'free_delivery', label: t('cp.tFree') }]} />
        {f.type !== 'free_delivery' && <label className="small"><strong>{t('cp.value')}</strong><input className="input" inputMode="numeric" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/\D/g, '') })} /></label>}
        <label className="small"><strong>{t('cp.ends')}</strong><input className="input" type="date" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></label>
        <small className="faint">{t('sg.couponHint')}</small>
      </div>
    </Modal>
  );
}
