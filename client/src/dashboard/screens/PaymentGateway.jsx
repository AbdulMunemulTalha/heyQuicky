import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { Button, Card, Checkbox, ErrorState, Modal, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';

// PAY-02 · Payments → Gateway (frame "PAY-02 · Payment gateway"): SSLCommerz, bKash Payment Gateway and
// Nagad Merchant cards, and what online payment is used for.
const LOGO = { sslcommerz: ['SSL', '#1d4ed8'], bkash: ['bK', '#e2136e'], nagad: ['Ng', '#f6921e'] };

export default function PaymentGateway({ t }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => dash('/payments/gateway').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('pg.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={260} r={12} />;
  const anyOn = d.gateways.some((g) => g.connected);
  async function use(patch) {
    try { const r = await dash('/payments/gateway/use', { method: 'PATCH', body: patch }); setD((x) => ({ ...x, ...r })); toast(t('pg.saved'), 'green'); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <>
      <div className="pg-cards">
        {d.gateways.map((g) => (
          <Card key={g.key} className="pg-card">
            <div className="row pg-top">
              <span className="pg-logo" style={{ background: LOGO[g.key][1] }} aria-hidden="true">{LOGO[g.key][0]}</span>
              <span className="grow" />
              {g.connected ? <Pill tone="green">{g.sandbox ? t('pg.sandboxOn') : t('pg.connected')}</Pill> : <Pill>{t('pg.notConnected')}</Pill>}
            </div>
            <h3>{g.name}</h3>
            <p className="small muted">{t(`pg.about.${g.key}`)}</p>
            <p className="small muted pg-fee">{t('pg.fee', { fee: g.fee })}</p>
            {d.canEdit && (g.connected
              ? <Button onClick={() => setOpen(g)}>{t('pg.settings')}</Button>
              : <Button variant={g.key === 'sslcommerz' ? 'primary' : 'default'} onClick={() => setOpen(g)}>{t('pg.connect')}</Button>)}
          </Card>
        ))}
      </div>
      <Card className="pg-use" title={t('pg.useFor')}>
        {!anyOn && <p className="small muted">{t('pg.connectFirst')}</p>}
        <Checkbox checked={d.use.advance} disabled={!d.canEdit} onChange={(v) => use({ advance: v })} label={t('pg.use.advance')} hint={t('pg.use.advanceHint')} />
        <div className="row pg-full">
          <Checkbox checked={d.use.full} disabled={!d.canEdit} onChange={(v) => use({ full: v })} label={t('pg.use.full', { n: d.use.full_discount })} hint={t('pg.use.fullHint')} />
          {d.use.full && d.canEdit && (
            <label className="small pg-disc">{t('pg.discount')}
              <input className="input" inputMode="numeric" defaultValue={d.use.full_discount} aria-label={t('pg.discount')}
                onBlur={(e) => { const n = Number(e.target.value); if (n !== d.use.full_discount) use({ fullDiscount: n }); }} />%
            </label>
          )}
        </div>
        <Checkbox checked={d.use.deposit} disabled={!d.canEdit} onChange={(v) => use({ deposit: v })} label={t('pg.use.deposit')} hint={t('pg.use.depositHint')} />
      </Card>
      {open && <Connect t={t} g={open} onClose={() => setOpen(null)} onSaved={(r) => { setD((x) => ({ ...x, ...r })); setOpen(null); }} />}
    </>
  );
}

function Connect({ t, g, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ sandbox: g.connected ? g.sandbox : true, ...Object.fromEntries(g.fields.map((x) => [x.key, x.value])) }));
  const [busy, setBusy] = useState('');
  const missing = g.fields.some((x) => !x.optional && !x.saved && !String(f[x.key] ?? '').trim());
  async function save() {
    setBusy('save');
    try { const r = await dash(`/payments/gateway/${g.key}`, { method: 'PUT', body: f }); toast(t('pg.connectedOk', { name: g.name }), 'green'); onSaved(r); } catch (err) { toast(err.message, 'red'); setBusy(''); }
  }
  async function disconnect() {
    setBusy('off');
    try { const r = await dash(`/payments/gateway/${g.key}`, { method: 'DELETE' }); toast(t('pg.disconnected', { name: g.name }), 'green'); onSaved(r); } catch (err) { toast(err.message, 'red'); setBusy(''); }
  }
  return (
    <Modal title={g.connected ? g.name : t('pg.connectTitle', { name: g.name })} subtitle={t(`pg.where.${g.key}`)} onClose={onClose} footer={(
      <>
        {g.connected && <Button className="pg-danger" busy={busy === 'off'} onClick={disconnect}>{t('pg.disconnect')}</Button>}
        <span className="grow" />
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy === 'save'} disabled={missing} onClick={save}>{g.connected ? t('common.save') : t('pg.connect')}</Button>
      </>
    )}>
      <div className="pg-form">
        {g.fields.map((x) => {
          const long = /key/.test(x.key) && g.key === 'nagad';
          const props = { id: `pg-${x.key}`, className: 'input', value: f[x.key] ?? '', autoComplete: 'off', spellCheck: false,
            placeholder: x.saved && x.secret ? t('pg.savedSecret') : x.optional ? t('pm.optional') : '', onChange: (e) => setF((y) => ({ ...y, [x.key]: e.target.value })) };
          return (
            <div key={x.key} className="field">
              <label htmlFor={props.id}>{t(`pg.f.${x.key}`)}</label>
              {long ? <textarea rows={3} {...props} className="input pg-key" /> : <input type={x.secret ? 'password' : 'text'} {...props} />}
            </div>
          );
        })}
        <div className="row pg-sandbox"><Toggle checked={f.sandbox} onChange={(v) => setF((y) => ({ ...y, sandbox: v }))} label={t('pg.sandbox')} /><span className="small"><strong>{t('pg.sandbox')}</strong><br /><span className="muted">{t('pg.sandboxHint')}</span></span></div>
        <p className="small muted">🔒 {t('pg.keysSafe')}</p>
      </div>
    </Modal>
  );
}
