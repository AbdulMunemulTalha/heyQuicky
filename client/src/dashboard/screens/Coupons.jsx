import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Button, Card, Checkbox, Drawer, Empty, ErrorState, Kpi, Segmented, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import './coupons.css';

const AUDIENCES = ['everyone', 'new', 'returning', 'vip', 'after_review', 'broadcast'];
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// Phase 2 · Coupons (ORD-05), frame "Coupons — list": counters, one table, an on/off switch per
// coupon; clicking a row opens it in the drawer.
export default function Coupons() {
  const t = useT();
  const { can } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [drawer, setDrawer] = useState(null); // null | 'new' | coupon
  const load = useCallback(() => dash('/coupons').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState thing={t('cp.title')} error={error} onRetry={load} />;
  const edit = can('edit_products');
  const discount = (c) => (c.type === 'percent' ? t('cp.pctOff', { n: t.num(c.value) }) : c.type === 'amount' ? t('cp.amountOff', { n: t.money(c.value) }) : t('cp.freeDelivery'));
  const who = (c) => (c.audience === 'segment' ? t('cp.aud.segmentName', { name: c.segmentName || '—' })
    : c.audience === 'everyone' && c.minOrder > 0 ? t('cp.ordersOver', { n: t.money(c.minOrder) }) : t(`cp.aud.${c.audience}`));
  const ends = (c) => {
    if (c.status === 'expired') return t('cp.endedOn', { d: t.date(c.endsAt) });
    if (c.status === 'used_up') return t('cp.st.used_up');
    if (c.status === 'scheduled') return t('cp.startsOn', { d: t.date(c.startsAt) });
    return c.endsAt ? t.date(c.endsAt) : t('cp.noEndDate');
  };
  async function flip(c, on) {
    try { await dash(`/coupons/${c.id}`, { method: 'PATCH', body: { active: on } }); toast(on ? t('cp.resumed') : t('cp.paused'), 'green'); load(); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <div className="coupons">
      <header className="page-head">
        <div><h1>{t('cp.title')}</h1><p className="page-sub">{t('cp.sub')}</p></div>
        <div className="page-actions">{edit && <Button variant="primary" onClick={() => setDrawer('new')}>{t('cp.new')}</Button>}</div>
      </header>
      {d && (
        <div className="cp-kpis">
          <Kpi label={t('cp.kActive')} value={t.num(d.counts.live ?? 0)} />
          <Kpi label={t('cp.kOrders30')} value={t.num(d.month?.orders ?? 0)} />
          <Kpi label={t('cp.kSales30')} value={t.money(d.month?.revenue ?? 0)} />
          <Kpi label={t('cp.kAvg')} value={t.money(d.month?.avgDiscount ?? 0)} />
        </div>
      )}
      <Card pad={false}>
        {!d ? <div style={{ padding: 16 }}><Skeleton h={120} r={10} /></div> : d.coupons.length === 0 ? (
          <Empty icon="ticket" title={t('cp.empty')} actions={edit && <Button variant="primary" onClick={() => setDrawer('new')}>{t('cp.new')}</Button>}>{t('cp.emptySub')}</Empty>
        ) : (
          <div className="cp-tablewrap">
            <table className="cp-table">
              <thead>
                <tr>
                  <th scope="col">{t('cp.code')}</th><th scope="col">{t('cp.discount')}</th><th scope="col">{t('cp.who')}</th>
                  <th scope="col">{t('cp.used')}</th><th scope="col">{t('cp.sales')}</th><th scope="col">{t('cp.ends')}</th><th scope="col">{t('cp.status')}</th>
                </tr>
              </thead>
              <tbody>
                {d.coupons.map((c) => {
                  const on = c.active && ['live', 'scheduled'].includes(c.status);
                  return (
                    <tr key={c.id} className={edit ? 'cp-click' : ''} onClick={edit ? () => setDrawer(c) : undefined}>
                      <td>{edit ? <button type="button" className="cp-code" onClick={(e) => { e.stopPropagation(); setDrawer(c); }} aria-label={t('cp.editTitle', { code: c.code })}>{c.code}</button> : <span className="cp-code">{c.code}</span>}</td>
                      <td><strong>{discount(c)}</strong></td>
                      <td className="muted">{who(c)}</td>
                      <td>
                        <span className="cp-used">
                          <span className="cp-bar" aria-hidden="true"><span style={{ width: `${c.maxUses != null ? Math.min(100, (c.used / Math.max(1, c.maxUses)) * 100) : c.used ? 100 : 0}%` }} /></span>
                          <span>{t.num(c.used)}{c.maxUses != null && <> / {t.num(c.maxUses)}</>}</span>
                        </span>
                      </td>
                      <td>{t.money(c.revenue)}</td>
                      <td className={c.status === 'expired' ? 'muted' : ''}>{ends(c)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <Toggle size="sm" checked={on} disabled={!edit || ['expired', 'used_up'].includes(c.status)} onChange={(v) => flip(c, v)} label={t('cp.onFor', { code: c.code })} />
                      </td>
                    </tr>
                  );
                })}
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
  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('cp.deleteConfirm', { code: coupon.code }))) return;
    try { await dash(`/coupons/${coupon.id}`, { method: 'DELETE' }); toast(t('cp.deleted')); onSaved(); } catch (err) { toast(err.message, 'red'); }
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
      <>{coupon && coupon.used === 0 && <Button variant="ghost" className="cp-del" onClick={remove}>{t('common.delete')}</Button>}<Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!valid} onClick={save}>{coupon ? t('common.save') : t('cp.create')}</Button></>
    )}>
      <div className="cp-form">
        <label className="small" htmlFor="cp-code"><strong>{t('cp.code')}</strong></label>
        <div className="row" style={{ gap: 8 }}>
          <input id="cp-code" className="input cp-codein" value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="EID10" maxLength={20} disabled={locked} autoFocus={!coupon} />
          {!locked && <Button onClick={generate}>{t('cp.generate')}</Button>}
        </div>
        <small className="faint">{t(locked ? 'cp.codeLocked' : 'cp.codeHint')}</small>

        <span className="small"><strong>{t('cp.discount')}</strong></span>
        <Segmented label={t('cp.discount')} value={f.type} onChange={(v) => set('type', v)} items={[{ key: 'percent', label: t('cp.tPercent') }, { key: 'amount', label: t('cp.tAmount') }, { key: 'free_delivery', label: t('cp.tFree') }]} />
        {f.type !== 'free_delivery' && (
          <div className="cp-inline">
            <input className="input" inputMode="numeric" value={f.value} onChange={(e) => set('value', e.target.value.replace(/\D/g, ''))} aria-label={t('cp.value')} />
            <span className="cp-unit">{f.type === 'percent' ? '%' : '৳'}</span>
          </div>
        )}

        <div className="cp-two">
          <label className="small"><strong>{t('cp.minOrder')}</strong><input className="input" inputMode="numeric" value={f.minOrder} onChange={(e) => set('minOrder', e.target.value.replace(/\D/g, ''))} placeholder={t('cp.none')} /></label>
          <label className="small"><strong>{t('cp.maxUses')}</strong><input className="input" inputMode="numeric" value={f.maxUses} onChange={(e) => set('maxUses', e.target.value.replace(/\D/g, ''))} placeholder={t('cp.unlimited')} /></label>
          <label className="small"><strong>{t('cp.starts')}</strong><input className="input" type="date" value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} /></label>
          <label className="small"><strong>{t('cp.ends')}</strong><input className="input" type="date" value={f.endsAt} min={f.startsAt || undefined} onChange={(e) => set('endsAt', e.target.value)} /></label>
        </div>

        <label className="small cp-whosel"><strong>{t('cp.who')}</strong>
          <select className="input" value={f.audience} onChange={(e) => set('audience', e.target.value)} disabled={coupon?.audience === 'segment'}>
            {(coupon?.audience === 'segment' ? ['segment'] : AUDIENCES).map((a) => <option key={a} value={a}>{a === 'segment' ? t('cp.aud.segmentName', { name: coupon.segmentName || '—' }) : t(`cp.aud.${a}`)}</option>)}
          </select>
          {f.audience !== 'segment' && <small className="faint">{t(`cp.audHint.${f.audience}`)}</small>}
        </label>
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
