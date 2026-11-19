import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { setQuery } from '../lib/router.jsx';
import { Button, Card, Checkbox, Chips, Drawer, Empty, ErrorState, Kpi, Pill, Segmented, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import './coupons.css';

const STATUSES = ['all', 'live', 'scheduled', 'used_up', 'expired', 'paused'];
const TONE = { live: 'green', scheduled: 'blue', used_up: 'gray', expired: 'gray', paused: 'yellow' };
const AUDIENCES = ['everyone', 'new', 'returning', 'vip', 'after_review', 'broadcast'];
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// Phase 2 · Coupons (ORD-05): codes the team, the order form and the AI use.
export default function Coupons({ query }) {
  const t = useT();
  const { can } = useDash();
  const filter = STATUSES.includes(query.status) ? query.status : 'all';
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [drawer, setDrawer] = useState(null); // null | 'new' | coupon
  const load = useCallback(() => dash('/coupons').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState thing={t('cp.title')} error={error} onRetry={load} />;
  const edit = can('edit_products');
  const discount = (c) => (c.type === 'percent' ? t('cp.pctOff', { n: t.num(c.value) }) : c.type === 'amount' ? t('cp.amountOff', { n: t.money(c.value) }) : t('cp.freeDelivery'));
  async function patch(c, body, ok) {
    try { await dash(`/coupons/${c.id}`, { method: 'PATCH', body }); if (ok) toast(ok, 'green'); load(); } catch (err) { toast(err.message, 'red'); }
  }
  async function remove(c) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('cp.deleteConfirm', { code: c.code }))) return;
    try { await dash(`/coupons/${c.id}`, { method: 'DELETE' }); toast(t('cp.deleted')); load(); } catch (err) { toast(err.message, 'red'); }
  }
  const rows = d ? d.coupons.filter((c) => filter === 'all' || c.status === filter) : [];
  return (
    <div className="coupons">
      <header className="page-head">
        <div><h1>{t('cp.title')}</h1><p className="page-sub">{t('cp.sub')}</p></div>
        <div className="page-actions">{edit && <Button variant="dark" onClick={() => setDrawer('new')}>{t('cp.new')}</Button>}</div>
      </header>
      {d && (
        <div className="cp-kpis">
          <Kpi label={t('cp.kOrders')} value={t.num(d.totals.orders)} />
          <Kpi label={t('cp.kRevenue')} value={t.money(d.totals.revenue)} />
          <Kpi label={t('cp.kGiven')} value={t.money(d.totals.given)} />
          <Kpi label={t('cp.kLive')} value={t.num(d.counts.live ?? 0)} />
        </div>
      )}
      <Card pad={false}>
        <div className="cp-filters">
          <Chips label={t('cp.filter')} value={filter} onChange={(v) => setQuery({ status: v === 'all' ? null : v })}
            items={STATUSES.map((s) => ({ key: s, label: t(`cp.st.${s}`), count: s === 'all' ? d?.counts.all : d?.counts[s] ?? 0 }))} />
        </div>
        {!d ? <div style={{ padding: 16 }}><Skeleton h={120} r={10} /></div> : rows.length === 0 ? (
          <Empty icon="ticket" title={t(filter === 'all' ? 'cp.empty' : 'cp.emptyFilter')} actions={edit && filter === 'all' && <Button variant="primary" onClick={() => setDrawer('new')}>{t('cp.new')}</Button>}>{t('cp.emptySub')}</Empty>
        ) : (
          <div className="cp-tablewrap">
            <table className="cp-table">
              <thead>
                <tr>
                  <th scope="col">{t('cp.code')}</th><th scope="col">{t('cp.discount')}</th><th scope="col">{t('cp.uses')}</th>
                  <th scope="col">{t('cp.dates')}</th><th scope="col">{t('cp.who')}</th><th scope="col">{t('cp.sales')}</th>
                  <th scope="col">{t('cp.ai')}</th><th scope="col"><span className="sr-only">{t('cp.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td><strong className="cp-code">{c.code}</strong> <Pill tone={TONE[c.status]}>{t(`cp.st.${c.status}`)}</Pill></td>
                    <td>{discount(c)}{c.minOrder > 0 && <small className="muted"> · {t('cp.over', { n: t.money(c.minOrder) })}</small>}</td>
                    <td>
                      {t.num(c.used)}{c.maxUses != null && <span className="muted"> / {t.num(c.maxUses)}</span>}
                      {c.maxUses != null && <span className="cp-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, (c.used / c.maxUses) * 100)}%` }} /></span>}
                    </td>
                    <td className="small">{c.startsAt || c.endsAt ? `${c.startsAt ? t.date(c.startsAt) : t('cp.now')} – ${c.endsAt ? t.date(c.endsAt) : t('cp.noEnd')}` : t('cp.always')}</td>
                    <td className="small">{c.audience === 'segment' ? t('cp.aud.segmentName', { name: c.segmentName || '—' }) : t(`cp.aud.${c.audience}`)}</td>
                    <td className="small">{c.orders ? <>{t.money(c.revenue)}<small className="muted"> · {t('cp.ordersN', { n: t.num(c.orders) })}</small></> : <span className="muted">—</span>}</td>
                    <td><Toggle size="sm" checked={c.aiMayMention && c.audience === 'everyone'} disabled={!edit || c.audience !== 'everyone'} onChange={(on) => patch(c, { aiMayMention: on })} label={t('cp.aiMay')} /></td>
                    <td className="cp-actions">
                      {edit && <Button size="sm" variant="ghost" onClick={() => setDrawer(c)}>{t('common.edit')}</Button>}
                      {edit && (c.active ? <Button size="sm" variant="ghost" onClick={() => patch(c, { active: false }, t('cp.paused'))}>{t('cp.pause')}</Button>
                        : <Button size="sm" variant="ghost" onClick={() => patch(c, { active: true }, t('cp.resumed'))}>{t('cp.resume')}</Button>)}
                      {edit && c.used === 0 && <Button size="sm" variant="ghost" onClick={() => remove(c)}>{t('common.delete')}</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {drawer && <CouponDrawer t={t} coupon={drawer === 'new' ? null : drawer} onClose={() => setDrawer(null)} onSaved={() => { setDrawer(null); load(); }} />}
    </div>
  );
}

function CouponDrawer({ t, coupon, onClose, onSaved }) {
  const [deliveryCharge, setDeliveryCharge] = useState(70);
  useEffect(() => { dash('/settings/delivery').then((x) => setDeliveryCharge(x.zones?.[0]?.charge ?? 70)).catch(() => {}); }, []);
  const [f, setF] = useState(() => (coupon ? {
    code: coupon.code, type: coupon.type, value: String(coupon.value || ''), minOrder: String(coupon.minOrder || ''), maxUses: coupon.maxUses == null ? '' : String(coupon.maxUses),
    startsAt: day(coupon.startsAt), endsAt: day(coupon.endsAt), audience: coupon.audience, aiMayMention: coupon.aiMayMention,
  } : { code: '', type: 'percent', value: '10', minOrder: '', maxUses: '', startsAt: '', endsAt: '', audience: 'everyone', aiMayMention: true }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function generate() {
    try { set('code', (await dash(`/coupons/generate?prefix=${encodeURIComponent(f.code.split('-')[0] || '')}`)).code); } catch (err) { toast(err.message, 'red'); }
  }
  async function save() {
    setBusy(true);
    const body = { code: f.code, type: f.type, value: f.type === 'free_delivery' ? 0 : Number(f.value), minOrder: Number(f.minOrder || 0), maxUses: f.maxUses === '' ? null : Number(f.maxUses),
      startsAt: f.startsAt || null, endsAt: f.endsAt ? `${f.endsAt}T23:59:59+06:00` : null, audience: f.audience, aiMayMention: f.aiMayMention };
    try {
      if (coupon) await dash(`/coupons/${coupon.id}`, { method: 'PATCH', body });
      else await dash('/coupons', { method: 'POST', body });
      toast(coupon ? t('common.saved') : t('cp.created', { code: f.code.toUpperCase() }), 'green');
      onSaved();
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  // "Bill after the code": a sample order just over the minimum.
  const min = Number(f.minOrder || 0);
  const subtotal = Math.max(min, 2000);
  const off = f.type === 'percent' ? Math.round(subtotal * (Number(f.value) || 0) / 100) : f.type === 'amount' ? Math.min(Number(f.value) || 0, subtotal) : 0;
  const delivery = f.type === 'free_delivery' ? 0 : deliveryCharge;
  const valid = /^[A-Za-z0-9][A-Za-z0-9-]{2,19}$/.test(f.code) && (f.type === 'free_delivery' || Number(f.value) > 0);
  const locked = coupon && coupon.used > 0;
  return (
    <Drawer title={coupon ? t('cp.editTitle', { code: coupon.code }) : t('cp.newTitle')} onClose={onClose} width={440} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!valid} onClick={save}>{coupon ? t('common.save') : t('cp.create')}</Button></>
    )}>
      <div className="cp-form">
        <label className="small" htmlFor="cp-code"><strong>{t('cp.code')}</strong></label>
        <div className="row" style={{ gap: 8 }}>
          <input id="cp-code" className="input cp-codein" value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="EID10" maxLength={20} disabled={locked} autoFocus={!coupon} />
          {!locked && <Button onClick={generate}>{t('cp.generate')}</Button>}
        </div>
        {locked && <small className="faint">{t('cp.codeLocked')}</small>}

        <span className="small"><strong>{t('cp.discount')}</strong></span>
        <Segmented label={t('cp.discount')} value={f.type} onChange={(v) => set('type', v)} items={[{ key: 'percent', label: t('cp.tPercent') }, { key: 'amount', label: t('cp.tAmount') }, { key: 'free_delivery', label: t('cp.tFree') }]} />
        {f.type !== 'free_delivery' && (
          <div className="cp-inline">
            <input className="input" inputMode="numeric" value={f.value} onChange={(e) => set('value', e.target.value.replace(/\D/g, ''))} aria-label={t('cp.value')} />
            <span className="muted">{f.type === 'percent' ? '%' : '৳'}</span>
          </div>
        )}

        <div className="cp-two">
          <label className="small"><strong>{t('cp.minOrder')}</strong><input className="input" inputMode="numeric" value={f.minOrder} onChange={(e) => set('minOrder', e.target.value.replace(/\D/g, ''))} placeholder={t('cp.none')} /></label>
          <label className="small"><strong>{t('cp.maxUses')}</strong><input className="input" inputMode="numeric" value={f.maxUses} onChange={(e) => set('maxUses', e.target.value.replace(/\D/g, ''))} placeholder={t('cp.unlimited')} /></label>
          <label className="small"><strong>{t('cp.starts')}</strong><input className="input" type="date" value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} /></label>
          <label className="small"><strong>{t('cp.ends')}</strong><input className="input" type="date" value={f.endsAt} min={f.startsAt || undefined} onChange={(e) => set('endsAt', e.target.value)} /></label>
        </div>

        <fieldset className="cp-who">
          <legend className="small"><strong>{t('cp.who')}</strong></legend>
          {AUDIENCES.map((a) => (
            <label key={a} className={`cp-aud${f.audience === a ? ' on' : ''}`}>
              <input type="radio" name="aud" checked={f.audience === a} onChange={() => set('audience', a)} />
              <span><strong>{t(`cp.aud.${a}`)}</strong><small className="muted">{t(`cp.audHint.${a}`)}</small></span>
            </label>
          ))}
        </fieldset>
        <Checkbox checked={f.aiMayMention && f.audience === 'everyone'} disabled={f.audience !== 'everyone'} onChange={(v) => set('aiMayMention', v)} label={t('cp.aiMay')} hint={t(f.audience === 'everyone' ? 'cp.aiMayHint' : 'cp.aiMayOnlyEveryone')} />

        <div className="cp-bill" aria-live="polite">
          <span className="small muted">{t('cp.bill')}</span>
          <div className="cp-line"><span>{t('cp.billItems')}</span><span>{t.money(subtotal)}</span></div>
          <div className="cp-line"><span>{t('cp.billDelivery')}</span><span>{f.type === 'free_delivery' ? <><s className="muted">{t.money(deliveryCharge)}</s> {t.money(0)}</> : t.money(delivery)}</span></div>
          {off > 0 && <div className="cp-line cp-off"><span>{t('cp.billCode', { code: f.code || 'CODE' })}</span><span>−{t.money(off)}</span></div>}
          <div className="cp-line cp-total"><span>{t('cp.billTotal')}</span><span>{t.money(subtotal + delivery - off)}</span></div>
          {min > 0 && <small className="faint">{t('cp.billMin', { n: t.money(min) })}</small>}
        </div>
      </div>
    </Drawer>
  );
}
