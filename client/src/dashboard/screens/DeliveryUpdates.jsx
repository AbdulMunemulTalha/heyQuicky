import { useCallback, useEffect, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { navigate } from '../lib/router.jsx';
import { Button, Checkbox, ErrorState, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import './deliveryupdates.css';

const STEPS = ['booked', 'picked', 'out_for_delivery', 'delivered', 'returned', 'failed'];
const ICON = { booked: '📦', picked: '🛵', out_for_delivery: '🛵', delivered: '✅', returned: '↩️', failed: '⏰' };
// The banner colour of each step's card in the preview.
const TONE = { booked: 'blue', picked: 'blue', out_for_delivery: 'yellow', delivered: 'green', returned: 'gray', failed: 'red' };
const PLACEHOLDERS = ['name', 'order', 'tracking', 'eta', 'cod'];
const BUTTONS = ['track', 'call_rider', 'bill'];
const CHIP = { steadfast: 'SF', pathao: 'PT', redx: 'RX', paperfly: 'PF', ecourier: 'EC' };

// Same filling as the server (src/dashboard/deliveryUpdates.js fillMessage), for the live preview.
function fill(t, template, sample) {
  const values = { name: sample.customer_name.split(' ')[0], order: sample.number, tracking: sample.consignment_id, eta: sample.delivery_inside_days || t('du.sampleEta'), cod: t.money(sample.cod_amount) };
  return String(template ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

// CRR-03 / CRR-05 / CRR-06 · Settings → Delivery updates (frame "Delivery updates").
export default function DeliveryUpdates() {
  const t = useT();
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [step, setStep] = useState('out_for_delivery');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const msgRef = useRef(null);
  const load = useCallback(() => dash('/settings/delivery-updates').then((x) => { setD(x); setF({ steps: x.steps, alerts: x.alerts, review: x.review }); }, setError), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState thing={t('du.title')} error={error} onRetry={load} />;
  if (!d || !f) return <Skeleton h={420} r={12} />;
  const edit = d.canEdit;
  const dirty = JSON.stringify(f) !== JSON.stringify({ steps: d.steps, alerts: d.alerts, review: d.review });
  const s = f.steps[step];
  const setStepField = (k, v) => setF((x) => ({ ...x, steps: { ...x.steps, [step]: { ...x.steps[step], [k]: v } } }));
  const flip = (k, on) => setF((x) => ({ ...x, steps: { ...x.steps, [k]: { ...x.steps[k], on } } }));
  function insert(p) {
    const el = msgRef.current;
    const token = `{${p}}`;
    const at = el ? el.selectionStart : s.message.length;
    const end = el ? el.selectionEnd : at;
    setStepField('message', s.message.slice(0, at) + token + s.message.slice(end));
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(at + token.length, at + token.length); } });
  }
  async function save() {
    setBusy(true);
    try { await dash('/settings/delivery-updates', { method: 'PUT', body: f }); toast(t('common.saved'), 'green'); await load(); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  const sentN = d.sent?.[step] ?? 0;
  const buttonLabel = { track: t('du.btn.track'), call_rider: t('du.btn.call_rider'), bill: t('du.btn.bill') }[s.button];
  return (
    <div className="du">
      <button type="button" className="du-back" onClick={() => navigate('/settings/courier')}>← {t('settingsNav.courier')}</button>
      <header className="page-head">
        <div><h1>{t('du.title')}</h1><p className="page-sub">{t('du.sub')}</p></div>
        {edit && <div className="page-actions"><Button variant="primary" busy={busy} disabled={!dirty} onClick={save}>{t('common.save')}</Button></div>}
      </header>
      <div className="du-layout">
        <div className="card du-steps">
          <ul role="tablist" aria-label={t('du.steps')}>
            {STEPS.map((k) => (
              <li key={k} className={step === k ? 'on' : ''}>
                <button type="button" role="tab" aria-selected={step === k} className="du-step" onClick={() => setStep(k)}>
                  <span className="du-ico" aria-hidden="true">{ICON[k]}</span>
                  <span className="du-stepname"><strong>{t(`du.step.${k}`)}</strong><small className="muted">{t(`du.stepHint.${k}`)}</small></span>
                </button>
                <Toggle size="sm" checked={f.steps[k].on} disabled={!edit} onChange={(v) => flip(k, v)} label={t('du.sendFor', { s: t(`du.step.${k}`) })} />
              </li>
            ))}
          </ul>
        </div>

        <div className="du-mid">
          <div className="card du-editor">
            <div className="du-edhead">
              <h3>{t(`du.step.${step}`)}</h3>
              <Pill tone={sentN ? 'green' : 'gray'}>{t('du.sentTimes', { n: t.num(sentN) })}</Pill>
            </div>
            {!s.on && <p className="small muted du-offnote">{t('du.stepOff')}</p>}
            <label className="du-label" htmlFor="du-title">{t('du.cardTitle')}</label>
            <input id="du-title" className="input" value={s.title} onChange={(e) => setStepField('title', e.target.value)} maxLength={60} disabled={!edit} />
            <label className="du-label" htmlFor="du-msg">{t('du.message')}</label>
            <textarea id="du-msg" ref={msgRef} className="input" rows={3} value={s.message} onChange={(e) => setStepField('message', e.target.value)} maxLength={400} disabled={!edit} />
            <div className="du-insert">
              <small className="muted">{t('du.insert')}</small>
              {PLACEHOLDERS.map((p) => <button key={p} type="button" className="du-ph" disabled={!edit} onClick={() => insert(p)} title={t(`du.ph.${p}`)}>{`{${p}}`}</button>)}
            </div>
            <label className="du-label" htmlFor="du-btn">{t('du.button')}</label>
            <select id="du-btn" className="input" value={s.button} onChange={(e) => setStepField('button', e.target.value)} disabled={!edit}>
              {BUTTONS.map((b) => <option key={b} value={b}>{t(`du.btn.${b}`)}</option>)}
            </select>
            {s.button === 'call_rider' && <small className="faint">{t('du.riderHint')}</small>}

            <div className="du-wrong">
              <strong className="small">{t('du.wrong')}</strong>
              <Checkbox checked={f.alerts.cancel_after_ship} disabled={!edit} onChange={(v) => setF((x) => ({ ...x, alerts: { ...x.alerts, cancel_after_ship: v } }))} label={t('du.alertCancel')} hint={t('du.alertCancelHint')} />
              <Checkbox checked={f.alerts.handoff_failed} disabled={!edit} onChange={(v) => setF((x) => ({ ...x, alerts: { ...x.alerts, handoff_failed: v } }))} label={t('du.handoffFailed')} hint={t('du.handoffFailedHint')} />
            </div>
          </div>

          <div className="card du-review">
            <span className="du-star" aria-hidden="true">⭐</span>
            <div className="grow">
              <strong className="small">{t('du.review')}</strong>
              <small className="muted">{t('du.reviewHint')}</small>
              <span className="du-coupon">
                <small className="muted">{t('du.reviewCoupon')}</small>
                <select className="input input-sm" value={f.review.coupon} disabled={!edit || !f.review.on} onChange={(e) => setF((x) => ({ ...x, review: { ...x.review, coupon: e.target.value } }))} aria-label={t('du.reviewCoupon')}>
                  <option value="">{t('du.noCoupon')}</option>
                  {[...new Set([...(d.coupons ?? []), ...(f.review.coupon ? [f.review.coupon] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </span>
            </div>
            <Toggle checked={f.review.on} disabled={!edit} onChange={(v) => setF((x) => ({ ...x, review: { ...x.review, on: v } }))} label={t('du.review')} />
          </div>
        </div>

        <div className="du-side">
          <div className="card du-preview">
            <small className="du-sidetitle">{t('du.customerSees')}</small>
            <div className="du-card">
              <div className={`du-banner tone-${TONE[step]}`}><span aria-hidden="true">{ICON[step]}</span><strong className="bn-ok">{s.title || '—'}</strong></div>
              <p className="bn-ok">{fill(t, s.message, d.sample)}</p>
              <span className="du-cardbtn">{buttonLabel}</span>
            </div>
            <small className="faint">{t('du.previewNote')}</small>
          </div>
          <div className="card du-couriers">
            <h3>{t('du.couriers')}</h3>
            <ul>
              {d.couriers.map((c) => (
                <li key={c.key}>
                  <span className={`du-chip c-${c.key}`} aria-hidden="true">{CHIP[c.key] ?? c.name.slice(0, 2).toUpperCase()}</span>
                  <span className="grow">
                    <strong className="small">{c.name}</strong>
                    <small className="muted">{c.connected ? [c.autoBook ? t('du.autoBook') : t('du.oneClick'), c.deliveredPct != null ? t('du.deliveredPct', { n: t.num(c.deliveredPct) }) : ''].filter(Boolean).join(' · ') : t('du.notConnected')}</small>
                  </span>
                  {c.connected ? <Pill tone="green">{t('du.connected')}</Pill> : <Button size="sm" onClick={() => navigate('/settings/courier')}>{t('set.connect')}</Button>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
