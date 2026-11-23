import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { navigate } from '../lib/router.jsx';
import { Button, ErrorState, Modal, Segmented, Skeleton, toast } from '../ui/kit.jsx';
import { TopupDialog } from './Settings.jsx';
import './plan.css';

// Phase 2 · Plan & upgrade, top up (BIL-01/04/05), frame "Plan & upgrade, top up".
export default function Plan() {
  const t = useT();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('monthly');
  const [amount, setAmount] = useState(1000);
  const [topup, setTopup] = useState(null);
  const [asking, setAsking] = useState(null);
  const load = useCallback(() => dash('/settings/plan').then((x) => { setD(x); setPeriod(x.period ?? 'monthly'); }, setError), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('pl.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={420} r={12} />;
  const usedPct = d.usage.included ? Math.min(100, Math.round((d.usage.used / d.usage.included) * 100)) : null;
  const order = ['starter', 'growth', 'pro'];
  const m = d.topup.methods;
  return (
    <div className="plan">
      <button type="button" className="pl-back" onClick={() => navigate('/settings')}>← {t('nav.settings')}</button>
      <header className="page-head">
        <div><h1>{t('pl.title')}</h1><p className="page-sub">{t('pl.sub')}</p></div>
        <Segmented label={t('pl.billing')} value={period} onChange={setPeriod} items={[{ key: 'monthly', label: t('pl.monthly') }, { key: 'yearly', label: t('pl.yearly') }]} />
      </header>

      <div className="pl-current">
        <span><small>{t('pl.currentPlan')}</small><strong>{t(`pl.p.${d.current}`)}{d.renewsAt ? ` · ${t('pl.renews', { d: t.date(d.renewsAt) })}` : ''}</strong></span>
        <span className="pl-usage">
          <small>{t('pl.repliesMonth')}</small>
          <strong>{d.usage.included ? t('pl.usedOf', { n: t.num(d.usage.used), of: t.num(d.usage.included) }) : t.num(d.usage.used)}</strong>
        </span>
        {usedPct != null && <span className="pl-bar" aria-hidden="true"><span style={{ width: `${usedPct}%` }} /></span>}
        {usedPct != null && <span className={`pl-pct${usedPct >= 80 ? ' warn' : ''}`}>{t('pl.pctUsed', { n: t.num(usedPct) })}</span>}
      </div>

      <div className="pl-plans">
        {d.plans.map((p) => {
          const isCurrent = p.key === d.current;
          const price = period === 'yearly' ? p.yearly : p.monthly;
          const higher = order.indexOf(p.key) > order.indexOf(d.current);
          const requested = d.request?.plan === p.key;
          return (
            <div key={p.key} className={`card pl-card${p.popular ? ' popular' : ''}`}>
              {isCurrent ? <span className="pl-tag dark">{t('pl.yourPlan')}</span> : p.popular ? <span className="pl-tag">{t('pl.popular')}</span> : null}
              <strong className="pl-name">{t(`pl.p.${p.key}`)}</strong>
              <small className="muted">{t(`pl.for.${p.key}`)}</small>
              <div className="pl-price">
                {price ? <><strong>{t.money(price)}</strong><small className="muted">{period === 'yearly' ? t('pl.perYear') : t('pl.perMonth')}</small></> : <strong className="pl-soon">{t('pl.priceSoon')}</strong>}
              </div>
              <small className="pl-included">{p.replies ? t('pl.included', { n: t.num(p.replies) }) : t('pl.includedSoon')}</small>
              <ul className="pl-features">
                {p.features.map((f) => <li key={f}>✓ {t(`pl.f.${f}`)}</li>)}
              </ul>
              {isCurrent ? <Button disabled className="pl-btn">{t('pl.currentBtn')}</Button>
                : requested ? <Button disabled className="pl-btn">{t('pl.requested')}</Button>
                  : <Button variant={p.popular ? 'primary' : undefined} className="pl-btn" onClick={() => setAsking(p)}>{t(higher ? 'pl.upgradeTo' : 'pl.switchTo', { p: t(`pl.p.${p.key}`) })}</Button>}
            </div>
          );
        })}
      </div>

      <div className="pl-bottom">
        <div className="card pl-topup">
          <h3>{t('pl.topupTitle')}</h3>
          <div className="pl-amounts" role="radiogroup" aria-label={t('pl.topupTitle')}>
            {d.topup.amounts.map((a) => (
              <button key={a.amount} type="button" role="radio" aria-checked={amount === a.amount} className={`pl-amount${amount === a.amount ? ' on' : ''}`} onClick={() => setAmount(a.amount)}>
                <strong>{t.money(a.amount)}</strong>{a.replies != null && <small className="muted">{t('pl.approxReplies', { n: t.num(a.replies) })}</small>}
              </button>
            ))}
          </div>
          <div className="pl-pay">
            <button type="button" className="pl-paybtn bkash" disabled={!m.bkash} onClick={() => setTopup('bkash')}>{t('pl.payBkash')}</button>
            <button type="button" className="pl-paybtn nagad" disabled={!m.nagad} onClick={() => setTopup('nagad')}>{t('pl.payNagad')}</button>
            <button type="button" className="pl-paybtn card" disabled title={t('pl.cardSoon')}>{t('pl.card')}</button>
          </div>
          {!m.bkash && !m.nagad && <small className="muted">{t('pl.topupOff')}</small>}
          <small className="muted">{t('pl.creditNow', { n: t.money(Math.round(d.credit * 100) / 100) })}</small>
        </div>
        <div className="card pl-pays">
          <h3>{t('pl.paysTitle')}</h3>
          <div className="pl-row"><span>{t('pl.salesAi')}</span><strong>{t.money(d.pays.sales)}</strong></div>
          <div className="pl-row"><span>{t('pl.aiCost')}</span><strong>{t.money(d.pays.cost)}</strong></div>
          <div className="pl-row big"><span>{t('pl.perTaka')}</span><strong>{d.pays.perTaka != null ? t.money(d.pays.perTaka) : '—'}</strong></div>
          <small className="muted">{t('pl.cacheSaved', { n: t.money(d.pays.cacheSaved) })}</small>
        </div>
      </div>
      {topup && <TopupDialog t={t} method={topup} number={m[topup]} min={d.topup.min} max={d.topup.max} initialAmount={amount} onClose={() => setTopup(null)} onDone={() => { setTopup(null); load(); }} />}
      {asking && <AskPlan t={t} plan={asking} period={period} onClose={() => setAsking(null)} onDone={() => { setAsking(null); load(); }} />}
    </div>
  );
}

function AskPlan({ t, plan, period, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const price = period === 'yearly' ? plan.yearly : plan.monthly;
  async function send() {
    setBusy(true);
    try { await dash('/settings/plan/request', { method: 'POST', body: { plan: plan.key, period } }); toast(t('pl.askedToast'), 'green'); onDone(); } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={t('pl.askTitle', { p: t(`pl.p.${plan.key}`) })} onClose={onClose} width={420}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} onClick={send}>{t('pl.askSend')}</Button></>}>
      <p className="small">{price ? t('pl.askPriced', { price: t.money(price), per: period === 'yearly' ? t('pl.perYear') : t('pl.perMonth') }) : t('pl.askNoPrice')}</p>
      <p className="small muted">{t('pl.askHow')}</p>
    </Modal>
  );
}
