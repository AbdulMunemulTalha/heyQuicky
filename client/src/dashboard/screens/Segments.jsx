import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Button, Card, Drawer, Empty, ErrorState, Modal, Pill, Segmented, Skeleton, toast } from '../ui/kit.jsx';
import './segments.css';

const COLOURS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple'];
const TEMPLATES = {
  repeat: [{ field: 'orders', op: 'gte', value: 2 }],
  big: [{ field: 'spent', op: 'gte', value: 10000 }],
  lapsed: [{ field: 'orders', op: 'gte', value: 1 }, { field: 'active_days', op: 'gte', value: 60 }],
  risky: [{ field: 'risk', op: 'is', value: 'high' }],
};

// Phase 2 · Tags & segments (CRM-03 / CRM-04).
export default function Segments() {
  const t = useT();
  const { can } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | { id?, name, conditions }
  const [coupon, setCoupon] = useState(null);
  const [members, setMembers] = useState(null);
  const load = useCallback(() => dash('/segments').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('sg.title')} error={error} onRetry={load} />;
  const edit = can('reply');

  async function tagAll(s) {
    // eslint-disable-next-line no-alert
    const tag = window.prompt(t('sg.tagPrompt', { n: s.count }));
    if (!tag) return;
    try { const r = await dash(`/segments/${s.id}/tag`, { method: 'POST', body: { tag } }); toast(t('sg.tagged', { n: t.num(r.tagged), tag }), 'green'); load(); } catch (err) { toast(err.message, 'red'); }
  }
  async function remove(s) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('sg.deleteConfirm', { name: s.name }))) return;
    try { await dash(`/segments/${s.id}`, { method: 'DELETE' }); load(); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <div className="segments">
      <header className="page-head">
        <div><h1>{t('sg.title')}</h1><p className="page-sub">{t('sg.sub')}</p></div>
        <div className="page-actions">{edit && <Button variant="dark" onClick={() => setEditing({ name: '', conditions: [{ field: 'orders', op: 'gte', value: 2 }] })}>{t('sg.new')}</Button>}</div>
      </header>
      {!d ? <Skeleton h={320} r={12} /> : (
        <div className="sg-layout">
          <Card title={t('sg.segments')} pad={false}>
            {d.segments.length === 0 ? (
              <div className="sg-empty">
                <Empty icon="customers" title={t('sg.empty')}>{t('sg.emptySub')}</Empty>
                {edit && <div className="sg-templates">{Object.keys(TEMPLATES).map((k) => <Button key={k} size="sm" onClick={() => setEditing({ name: t(`sg.tpl.${k}`), conditions: TEMPLATES[k] })}>{t(`sg.tpl.${k}`)}</Button>)}</div>}
              </div>
            ) : (
              <ul className="sg-list">
                {d.segments.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="sg-main" onClick={() => setMembers(s)}>
                      <strong className="bn-ok">{s.name}</strong>
                      <small className="muted">{s.conditions.map((c) => describe(t, c)).join(' · ')}</small>
                    </button>
                    <span className="sg-count"><strong>{t.num(s.count)}</strong><small className="muted">{t('sg.customers')}</small></span>
                    {edit && (
                      <div className="sg-actions">
                        <Button size="sm" onClick={() => navigate(`/growth?tab=broadcasts&segment=${s.id}`)}>{t('sg.broadcast')}</Button>
                        <Button size="sm" onClick={() => setCoupon(s)}>{t('sg.coupon')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => tagAll(s)}>{t('sg.tagAll')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ id: s.id, name: s.name, conditions: s.conditions })}>{t('common.edit')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(s)}>{t('common.delete')}</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Tags t={t} d={d} edit={edit} onChange={load} />
        </div>
      )}
      {editing && <SegmentEditor t={t} seg={editing} fields={d?.fields ?? {}} tags={d?.tags ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {coupon && <GiveCoupon t={t} seg={coupon} onClose={() => setCoupon(null)} />}
      {members && <Members t={t} seg={members} onClose={() => setMembers(null)} />}
    </div>
  );
}

function describe(t, c) {
  const v = c.field === 'risk' ? t(`sg.risk.${c.value}`) : c.field === 'vip' ? t(c.value ? 'sg.yes' : 'sg.no') : c.field === 'spent' ? t.money(c.value) : c.value;
  return t(`sg.desc.${c.field}.${c.op}`, { v });
}

function Tags({ t, d, edit, onChange }) {
  const [name, setName] = useState('');
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
  return (
    <Card title={t('sg.tags')}>
      <span className="small muted">{t('sg.autoTags')}</span>
      <ul className="sg-tags">
        {d.autoTags.map((a) => (
          <li key={a.key}><Pill tone={a.key === 'high_risk' ? 'red' : a.key === 'vip' ? 'purple' : 'blue'}>{t(`sg.auto.${a.key}`)}</Pill><span className="grow" /><small className="muted">{t.num(a.count)}</small></li>
        ))}
      </ul>
      <p className="small muted sg-riskhint">{t('sg.riskHint')}</p>
      <span className="small muted">{t('sg.manualTags')}</span>
      {d.tags.length === 0 ? <p className="small muted">{t('sg.noTags')}</p> : (
        <ul className="sg-tags">
          {d.tags.map((tag) => (
            <li key={tag.name}>
              <Pill tone={tag.colour}>{tag.name}</Pill>
              <span className="grow" />
              <small className="muted">{t.num(tag.count)}</small>
              {edit && (
                <>
                  <select className="input sg-colour" value={tag.colour} onChange={(e) => patch(tag, { colour: e.target.value })} aria-label={t('sg.colour', { tag: tag.name })}>
                    {COLOURS.map((c) => <option key={c} value={c}>{t(`sg.c.${c}`)}</option>)}
                  </select>
                  <button type="button" className="sg-icon" onClick={() => rename(tag)} aria-label={t('sg.rename', { tag: tag.name })}>✎</button>
                  <button type="button" className="sg-icon" onClick={() => remove(tag)} aria-label={t('sg.deleteTag', { tag: tag.name })}>×</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <form className="sg-addtag" onSubmit={add}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sg.tagPlaceholder')} aria-label={t('sg.newTag')} maxLength={30} />
          <Button type="submit" size="sm" disabled={!name.trim()}>{t('sg.addTag')}</Button>
        </form>
      )}
    </Card>
  );
}

function SegmentEditor({ t, seg, fields, tags, onClose, onSaved }) {
  const [name, setName] = useState(seg.name);
  const [conds, setConds] = useState(seg.conditions.map((c) => ({ ...c })));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => dash('/segments/preview', { method: 'POST', body: { conditions: conds } }).then(setPreview, (err) => setPreview({ error: err.message })), 350);
    return () => clearTimeout(timer);
  }, [conds]);
  const setC = (i, patch) => setConds((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const defaults = { orders: 2, spent: 5000, returned: 1, active_days: 30, tag: tags[0]?.name ?? 'VIP', vip: true, risk: 'high', area: 'Dhaka' };
  async function save() {
    setBusy(true);
    try {
      if (seg.id) await dash(`/segments/${seg.id}`, { method: 'PATCH', body: { name, conditions: conds } });
      else await dash('/segments', { method: 'POST', body: { name, conditions: conds } });
      toast(t('common.saved'), 'green'); onSaved();
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={seg.id ? t('sg.editTitle') : t('sg.newTitle')} onClose={onClose} width={640} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!name.trim() || !conds.length || preview?.error} onClick={save}>{t('common.save')}</Button></>
    )}>
      <div className="sg-form">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sg.namePlaceholder')} aria-label={t('sg.name')} maxLength={60} autoFocus />
        <span className="small"><strong>{t('sg.matchAll')}</strong></span>
        {conds.map((c, i) => {
          const f = fields[c.field] ?? { ops: [], type: 'number' };
          return (
            <div key={i} className="sg-cond">
              <select className="input" value={c.field} onChange={(e) => { const k = e.target.value; setC(i, { field: k, op: fields[k].ops[0], value: defaults[k] }); }} aria-label={t('sg.field')}>
                {Object.keys(fields).map((k) => <option key={k} value={k}>{t(`sg.f.${k}`)}</option>)}
              </select>
              <select className="input" value={c.op} onChange={(e) => setC(i, { op: e.target.value })} aria-label={t('sg.op')}>
                {f.ops.map((o) => <option key={o} value={o}>{t(`sg.op.${o}`)}</option>)}
              </select>
              {f.type === 'risk' ? (
                <select className="input" value={c.value} onChange={(e) => setC(i, { value: e.target.value })} aria-label={t('sg.value')}>{['low', 'medium', 'high'].map((r) => <option key={r} value={r}>{t(`sg.risk.${r}`)}</option>)}</select>
              ) : f.type === 'bool' ? (
                <select className="input" value={String(c.value)} onChange={(e) => setC(i, { value: e.target.value === 'true' })} aria-label={t('sg.value')}><option value="true">{t('sg.yes')}</option><option value="false">{t('sg.no')}</option></select>
              ) : c.field === 'tag' ? (
                <input className="input" list="sg-taglist" value={c.value} onChange={(e) => setC(i, { value: e.target.value })} aria-label={t('sg.value')} />
              ) : (
                <input className="input" inputMode={f.type === 'number' ? 'numeric' : 'text'} value={c.value} onChange={(e) => setC(i, { value: f.type === 'number' ? e.target.value.replace(/\D/g, '') : e.target.value })} aria-label={t('sg.value')} />
              )}
              <button type="button" className="sg-icon" disabled={conds.length < 2} onClick={() => setConds(conds.filter((_, j) => j !== i))} aria-label={t('sg.removeCond')}>×</button>
            </div>
          );
        })}
        <datalist id="sg-taglist">{[...tags.map((x) => x.name), 'VIP', 'Repeat buyer', 'First order', 'Big spender', 'Returned before', 'High COD risk'].map((n) => <option key={n} value={n} />)}</datalist>
        <div><Button size="sm" disabled={conds.length >= 8} onClick={() => setConds([...conds, { field: 'orders', op: 'gte', value: 1 }])}>{t('sg.addCond')}</Button></div>
        <div className="sg-preview" aria-live="polite">
          {preview?.error ? <span className="small sg-err">{preview.error}</span> : preview ? (
            <><strong>{t('sg.matches', { n: t.num(preview.count) })}</strong>{preview.sample.length > 0 && <small className="muted"> · {preview.sample.join(', ')}{preview.count > preview.sample.length ? '…' : ''}</small>}</>
          ) : '…'}
        </div>
      </div>
    </Modal>
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

function Members({ t, seg, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { dash(`/segments/${seg.id}/customers`).then(setD).catch((err) => toast(err.message, 'red')); }, [seg.id]);
  return (
    <Drawer title={seg.name} onClose={onClose} width={460}>
      {!d ? <Skeleton h={200} r={10} /> : d.customers.length === 0 ? <Empty icon="customers" title={t('sg.noMembers')} /> : (
        <>
          <p className="small muted">{t('sg.showing', { n: t.num(Math.min(100, d.count)), of: t.num(d.count) })}</p>
          <ul className="sg-members">
            {d.customers.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => navigate(`/customers/${c.id}`)}>
                  <strong className="small">{c.name || '—'}</strong>
                  <small className="muted">{t('sg.memberLine', { o: t.num(c.orders), s: t.money(c.spent) })}{c.returned ? ` · ${t('sg.returnedN', { n: t.num(c.returned) })}` : ''}</small>
                </button>
                {c.vip && <Pill tone="purple">VIP</Pill>}
                {c.risk === 'high' && <Pill tone="red">{t('sg.risk.high')}</Pill>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Drawer>
  );
}
