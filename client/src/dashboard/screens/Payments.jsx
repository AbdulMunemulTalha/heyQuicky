import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Card, Chips, Empty, ErrorState, Kpi, Modal, Pill, Skeleton, Tabs, Toggle, toast } from '../ui/kit.jsx';
import PaymentGateway from './PaymentGateway.jsx';
import './payments.css';

const STATUSES = ['waiting', 'approved', 'rejected'];
const REJECT_REASONS = ['not_received', 'wrong_amount', 'wrong_trx', 'other'];
const CHECK_TONE = { matches: 'green', short: 'red', more: 'yellow', other_number: 'yellow', number_reused: 'yellow', no_order: 'blue' };

// Phase 2 · Payments (PAY-01 / PAY-03): verify bKash / Nagad advances and set when to ask for one.
export default function Payments({ query }) {
  const t = useT();
  const tab = ['rules', 'gateway'].includes(query.tab) ? query.tab : 'verify';
  return (
    <div className="payments">
      <header className="page-head">
        <div><h1>{t('pm.title')}</h1><p className="page-sub">{t('pm.sub')}</p></div>
      </header>
      <Tabs label={t('pm.title')} value={tab} onChange={(v) => setQuery({ tab: v === 'verify' ? null : v, status: null })}
        items={[{ key: 'verify', label: t('pm.tab.verify') }, { key: 'rules', label: t('pm.tab.rules') }, { key: 'gateway', label: t('pm.tab.gateway') }]} />
      {tab === 'verify' ? <Verify t={t} query={query} /> : tab === 'rules' ? <Rules t={t} /> : <PaymentGateway t={t} />}
    </div>
  );
}

function Verify({ t, query }) {
  const { socket, can } = useDash();
  const status = STATUSES.includes(query.status) ? query.status : 'waiting';
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => dash(`/payments?status=${status}`).then(setD, setError), [status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('payment', load);
    return () => socket.off('payment', load);
  }, [socket, load]);
  if (error) return <ErrorState thing={t('pm.title')} error={error} onRetry={load} />;
  const edit = can('edit_orders');
  return (
    <>
      {d && (
        <div className="pm-kpis">
          <Kpi label={t('pm.kWaiting')} value={t.num(d.counts.waiting)} sub={t.money(d.waitingAmount)} tone={d.counts.waiting ? 'yellow' : undefined} />
          <Kpi label={t('pm.kToday2')} value={`${t.num(d.approvedToday.count)} · ${t.money(d.approvedToday.amount)}`} tone="green" />
          <Kpi label={t('pm.kRejectedToday')} value={t.num(d.rejectedToday)} tone={d.rejectedToday ? 'red' : undefined} />
          <Kpi label={t('pm.kSpeed')} value={d.avgApproveMin == null ? '—' : t('tm.minutes', { n: t.num(d.avgApproveMin) })} />
        </div>
      )}
      <div className="pm-bar">
        <Chips label={t('pm.filter')} value={status} onChange={(v) => setQuery({ status: v === 'waiting' ? null : v })}
          items={STATUSES.map((s) => ({ key: s, label: t(`pm.st.${s}`), count: d?.counts[s] }))} />
        {edit && <Button onClick={() => setAdding(true)}>{t('pm.add')}</Button>}
      </div>
      {!d ? <Skeleton h={160} r={12} /> : d.payments.length === 0 ? (
        <Card><Empty icon="card" tone="green" title={t(`pm.empty.${status}`)}>{status === 'waiting' && t('pm.emptySub')}</Empty></Card>
      ) : (
        <div className="pm-list">{d.payments.map((p) => <PaymentCard key={p.id} t={t} p={p} edit={edit && p.status === 'waiting'} onDone={load} />)}</div>
      )}
      {adding && <AddPayment t={t} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </>
  );
}

function PaymentCard({ t, p, edit, onDone }) {
  const [orderNumber, setOrderNumber] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('not_received');
  const [busy, setBusy] = useState(false);
  async function act(path, body, ok) {
    setBusy(true);
    try { await dash(`/payments/${p.id}/${path}`, { method: 'POST', body }); toast(ok, 'green'); onDone(); } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  const copy = () => navigator.clipboard?.writeText(p.trxId).then(() => toast(t('pm.copied')), () => {});
  return (
    <Card className={`pm-card${p.checks.includes('short') ? ' warn' : ''}`}>
      <div className="pm-top">
        {p.screenshot ? <a href={p.screenshot} target="_blank" rel="noreferrer" className="pm-shot" aria-label={t('pm.screenshot')}><img src={p.screenshot} alt={t('pm.screenshot')} /></a> : null}
        <span className={`pm-method ${p.method}`}>{p.gateway ? t('pg.online', { name: { sslcommerz: 'SSLCommerz', bkash: 'bKash', nagad: 'Nagad' }[p.gateway] }) : p.method === 'nagad' ? 'Nagad' : 'bKash'}</span>
        <div className="grow">
          <strong className="pm-amount">{t.money(p.amount)}</strong>
          {p.expected != null && <small className="muted"> · {t('pm.expected', { n: t.money(p.expected) })}</small>}
          <div className="pm-meta">
            <button type="button" className="pm-trx" onClick={copy} title={t('pm.copy')}>TrxID <code>{p.trxId}</code></button>
            {p.from && <span className="muted small">{t('pm.from', { n: p.from })}</span>}
            <span className="muted small">{t(`pm.src.${p.source}`)} · {t.ago(p.at)}</span>
          </div>
        </div>
        {p.status !== 'waiting' && <Pill tone={p.status === 'approved' ? 'green' : 'red'}>{t(`pm.st.${p.status}`)}{p.decidedBy && ` · ${p.decidedBy}`}</Pill>}
      </div>
      {p.checks.length > 0 && p.status === 'waiting' && <div className="pm-checks">{p.checks.map((c) => <Pill key={c} tone={CHECK_TONE[c]}>{t(`pm.check.${c}`)}</Pill>)}</div>}
      {p.order ? (
        <div className="pm-order">
          <button type="button" className="pm-link" onClick={() => navigate(`/orders/${p.order.number}`)}>{t('inbox.orderN', { n: p.order.number })}</button>
          <span className="small">{p.order.customer} · {p.order.phone}</span>
          <span className="small muted">{t('pm.orderTotal', { n: t.money(p.order.total) })} · {t('pm.cod', { n: t.money(p.status === 'waiting' ? Math.max(0, p.order.cod - p.amount) : p.order.cod) })}</span>
          <Pill tone="gray">{p.order.status.replace(/_/g, ' ')}</Pill>
        </div>
      ) : edit && (
        <div className="pm-order">
          <span className="small muted">{t('pm.whichOrder')}</span>
          <input className="input pm-num" inputMode="numeric" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value.replace(/\D/g, ''))} placeholder="#1234" aria-label={t('pm.orderNumber')} />
        </div>
      )}
      {p.status === 'rejected' && p.reason && <p className="small muted">{t('pm.rejectedFor', { r: t(`pm.reason.${p.reason}`, {}) })}</p>}
      {edit && (
        <div className="pm-actions">
          {rejecting ? (
            <>
              <select className="input" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t('pm.reasonLabel')}>
                {REJECT_REASONS.map((r) => <option key={r} value={r}>{t(`pm.reason.${r}`)}</option>)}
              </select>
              <Button size="sm" onClick={() => setRejecting(false)}>{t('common.cancel')}</Button>
              <Button size="sm" variant="danger" busy={busy} onClick={() => act('reject', { reason }, t('pm.rejected'))}>{t('pm.rejectNow')}</Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => setRejecting(true)}>{t('pm.reject')}</Button>
              <Button size="sm" variant="primary" busy={busy} disabled={!p.order && !orderNumber} onClick={() => act('approve', p.order ? {} : { orderNumber: Number(orderNumber) }, t('pm.approved'))}>{t('pm.approve')}</Button>
            </>
          )}
        </div>
      )}
      {edit && <small className="faint">{t('pm.tellsCustomer')}</small>}
    </Card>
  );
}

function AddPayment({ t, onClose, onDone }) {
  const [f, setF] = useState({ method: 'bkash', amount: '', trxId: '', from: '', orderNumber: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    setBusy(true);
    try { await dash('/payments', { method: 'POST', body: { ...f, amount: Number(f.amount), orderNumber: f.orderNumber ? Number(f.orderNumber) : null } }); toast(t('pm.addedOk'), 'green'); onDone(); } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={t('pm.addTitle')} subtitle={t('pm.addSub')} onClose={onClose} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!f.amount || f.trxId.length < 8} onClick={save}>{t('pm.addSave')}</Button></>
    )}>
      <div className="pm-form">
        <Chips label={t('pm.method')} value={f.method} onChange={(v) => set('method', v)} items={[{ key: 'bkash', label: 'bKash' }, { key: 'nagad', label: 'Nagad' }]} />
        <label className="small"><strong>{t('pm.amount')}</strong><input className="input" inputMode="numeric" value={f.amount} onChange={(e) => set('amount', e.target.value.replace(/\D/g, ''))} autoFocus /></label>
        <label className="small"><strong>TrxID</strong><input className="input pm-code" value={f.trxId} onChange={(e) => set('trxId', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))} /></label>
        <label className="small"><strong>{t('pm.fromNumber')}</strong><input className="input" inputMode="tel" value={f.from} onChange={(e) => set('from', e.target.value)} placeholder="01XXXXXXXXX" /></label>
        <label className="small"><strong>{t('pm.orderNumber')}</strong><input className="input" inputMode="numeric" value={f.orderNumber} onChange={(e) => set('orderNumber', e.target.value.replace(/\D/g, ''))} placeholder={t('pm.optional')} /></label>
      </div>
    </Modal>
  );
}

// The four advance rules from the design, each with its own advance (৳ or % of the order).
const RULES = ['outside_dhaka', 'courier_risk', 'order_over', 'first_order'];

function Rules({ t }) {
  const { me } = useDash();
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dash('/payments/rules').then((x) => {
    setD(x);
    setF({ bkash: x.bkash, bkashType: x.bkashType, nagad: x.nagad, message: x.advance.message,
      rules: Object.fromEntries(RULES.map((k) => [k, { ...x.advance.rules[k], value: String(x.advance.rules[k].value), below: String(x.advance.rules[k].below ?? ''), over: String(x.advance.rules[k].over ?? '') }])) });
  }, setError), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('pm.tab.rules')} error={error} onRetry={load} />;
  if (!f) return <Skeleton h={320} r={12} />;
  const editable = ['owner', 'admin'].includes(me?.user?.role);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setR = (k, patch) => setF((x) => ({ ...x, rules: { ...x.rules, [k]: { ...x.rules[k], ...patch } } }));
  const digits = (v) => v.replace(/\D/g, '');
  async function save() {
    setBusy(true);
    const rules = Object.fromEntries(RULES.map((k) => {
      const r = f.rules[k];
      return [k, { on: r.on, kind: r.kind, value: Number(r.value), ...(k === 'courier_risk' ? { below: Number(r.below) } : {}), ...(k === 'order_over' ? { over: Number(r.over) } : {}) }];
    }));
    try {
      await dash('/payments/rules', { method: 'PATCH', body: { bkash: f.bkash, bkashType: f.bkashType, nagad: f.nagad, advance: { rules, message: f.message } } });
      toast(t('common.saved'), 'green'); load();
    } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  // The chat preview uses the first rule that's on, with an example order of ৳2,500.
  const example = RULES.map((k) => f.rules[k]).find((r) => r.on);
  const exampleAmount = example ? (example.kind === 'percent' ? Math.round((2500 * Number(example.value || 0)) / 100) : Number(example.value || 0)) : 300;
  const preview = (f.message || d.defaultMessage).replace(/\{amount\}/g, t.money(exampleAmount)).replace(/\{method\}/g, f.bkash ? 'বিকাশ' : 'নগদ').replace(/\{number\}/g, f.bkash || f.nagad || '01XXXXXXXXX');
  return (
    <div className="pm-rules">
      <Card title={t('pm.askWhen')}>
        <ul className="pm-rulelist">
          {RULES.map((k) => {
            const r = f.rules[k];
            return (
              <li key={k} className={r.on ? '' : 'off'}>
                <div className="grow">
                  <strong className="small">
                    {k === 'order_over' ? (
                      <>{t('pm.rule2.order_over')} ৳<input className="input pm-num pm-inline" inputMode="numeric" value={r.over} onChange={(e) => setR(k, { over: digits(e.target.value) })} disabled={!editable} aria-label={t('pm.ruleOver')} /></>
                    ) : t(`pm.rule2.${k}`)}
                  </strong>
                  <small className="muted">
                    {k === 'courier_risk' ? (
                      <>{t('pm.ruleHint2.courier_risk')} <input className="input pm-num pm-inline" inputMode="numeric" value={r.below} onChange={(e) => setR(k, { below: digits(e.target.value) })} disabled={!editable} aria-label={t('pm.ruleBelow')} />%</>
                    ) : t(`pm.ruleHint2.${k}`)}
                  </small>
                </div>
                <span className="pm-amt">
                  <input className="input pm-num" inputMode="numeric" value={r.value} onChange={(e) => setR(k, { value: digits(e.target.value) })} disabled={!editable} aria-label={t('pm.ruleAmount', { r: t(`pm.rule2.${k}`) })} />
                  <select className="input pm-kind" value={r.kind} onChange={(e) => setR(k, { kind: e.target.value })} disabled={!editable} aria-label={t('pm.ruleKind')}>
                    <option value="fixed">৳</option><option value="percent">%</option>
                  </select>
                </span>
                <Toggle size="sm" checked={r.on} disabled={!editable} onChange={(on) => setR(k, { on })} label={t(`pm.rule2.${k}`)} />
              </li>
            );
          })}
        </ul>
        <small className="faint">{t('pm.rulesHint2')}</small>
        <div className="pm-numbers">
          <label className="small"><strong>{t('pm.bkashNumber')}</strong>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" inputMode="tel" value={f.bkash} onChange={(e) => set('bkash', e.target.value)} placeholder="01XXXXXXXXX" disabled={!editable} />
              <select className="input pm-type" value={f.bkashType} onChange={(e) => set('bkashType', e.target.value)} disabled={!editable} aria-label={t('pm.bkashType')}>
                {['personal', 'merchant', 'agent'].map((k) => <option key={k} value={k}>{t(`pm.type.${k}`)}</option>)}
              </select>
            </div>
          </label>
          <label className="small"><strong>{t('pm.nagadNumber')}</strong><input className="input" inputMode="tel" value={f.nagad} onChange={(e) => set('nagad', e.target.value)} placeholder="01XXXXXXXXX" disabled={!editable} /></label>
        </div>
        {!f.bkash && !f.nagad && <p className="small pm-note">{t('pm.noNumbers')}</p>}
      </Card>

      <Card title={t('pm.aiSays')}>
        <div className="pm-preview">
          <div className="pm-chat">
            <div className="bubble-c shop bn-ok">{preview}</div>
            <div className="bubble-c cust">TrxID BKH8X2K9QP</div>
            <div className="bubble-c shop bn-ok">{t('pm.previewThanks')}</div>
          </div>
        </div>
        <textarea className="input" rows={3} value={f.message} onChange={(e) => set('message', e.target.value)} maxLength={400} disabled={!editable} aria-label={t('pm.aiSays')} />
        <small className="faint">{t('pm.placeholders')}</small>
        {editable && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><Button variant="primary" busy={busy} onClick={save}>{t('common.save')}</Button></div>}
      </Card>
    </div>
  );
}
