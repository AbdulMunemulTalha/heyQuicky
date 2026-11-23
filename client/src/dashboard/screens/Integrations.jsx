import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, ErrorState, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import WooDialog from './WooDialog.jsx';
import './catalog.css';
import './integrations.css';

// The cards in the frame. The Conversions API, the website widget and WooCommerce import are built; the rest come later.
const GROUPS = [
  ['ads', [['capi', 'CA', '#1877f2'], ['ga', 'GA', '#e37400']]],
  ['website', [['widget', 'W', '#2b4bff'], ['shoplink', 'SL', '#111']]],
  ['stores', [['woo', 'Wo', '#7f54b3'], ['shopify', 'Sh', '#5e8e3e'], ['sheets', 'GS', '#188038']]],
  ['tools', [['extension', 'Ch', '#333'], ['webhooks', '{ }', '#6d28d9']]],
];
const BUILT = ['capi', 'widget', 'woo', 'shoplink'];
const EVENT_ORDER = ['purchase', 'lead', 'add_to_cart', 'delivered'];

// Phase 2 · Integrations (ANL-09, INT-02), frame "Integrations".
export default function Integrations({ query }) {
  const t = useT();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash('/integrations').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  const open = BUILT.includes(query.open) ? query.open : null;
  if (error) return <ErrorState thing={t('in.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={420} r={12} />;
  const state = (k) => {
    if (k === 'capi') return d.capi.connected ? ['green', t('in.connected')] : ['gray', t('in.notConnected')];
    if (k === 'widget') return d.widget.on ? ['green', t('in.live')] : ['gray', t('in.notSetUp')];
    if (k === 'shoplink') return d.shopLink?.products ? ['green', t('in.live')] : ['gray', t('in.notSetUp')];
    if (k === 'woo') return d.woo?.connected ? ['green', t('in.connected')] : ['gray', t('in.notConnected')];
    return ['blue', t('in.comingLater')];
  };
  return (
    <div className={`integrations${open && open !== 'woo' ? ' with-panel' : ''}`}>
      <div className="in-main">
        <button type="button" className="in-back" onClick={() => navigate('/settings')}>← {t('nav.settings')}</button>
        <header className="page-head"><div><h1>{t('in.title')}</h1><p className="page-sub">{t('in.sub')}</p></div></header>
        {GROUPS.map(([g, cards]) => (
          <section key={g} className="in-group">
            <small className="in-label">{t(`in.g.${g}`)}</small>
            <div className="in-grid">
              {cards.map(([k, chip, colour]) => {
                const [tone, label] = state(k);
                const built = BUILT.includes(k);
                return (
                  <button key={k} type="button" className={`card in-card${open === k ? ' on' : ''}${built ? '' : ' later'}`} disabled={!built} onClick={() => setQuery({ open: open === k ? null : k })}>
                    <span className="in-top"><span className="in-chip" style={{ background: colour }} aria-hidden="true">{chip}</span><Pill tone={tone}>{label}</Pill></span>
                    <strong>{t(`in.c.${k}`)}</strong>
                    <small className="muted">{t(`in.d.${k}`)}</small>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {open === 'capi' && <CapiPanel t={t} d={d} onChange={setD} onClose={() => setQuery({ open: null })} />}
      {open === 'widget' && <WidgetPanel t={t} d={d} onChange={setD} onClose={() => setQuery({ open: null })} />}
      {open === 'shoplink' && <ShopLinkPanel t={t} d={d} onClose={() => setQuery({ open: null })} />}
      {open === 'woo' && <WooDialog t={t} onClose={() => { setQuery({ open: null }); load(); }} onDone={load} />}
    </div>
  );
}

function Panel({ t, title, sub, chip, colour, onClose, children }) {
  return (
    <aside className="in-panel" aria-label={title}>
      <div className="in-phead">
        <span className="in-chip big" style={{ background: colour }} aria-hidden="true">{chip}</span>
        <span className="grow"><strong>{title}</strong><small className="muted">{sub}</small></span>
        <button type="button" className="in-close" onClick={onClose} aria-label={t('common.close')}>×</button>
      </div>
      {children}
    </aside>
  );
}

function CapiPanel({ t, d, onChange, onClose }) {
  const c = d.capi;
  const [f, setF] = useState({ pixelId: c.pixelId, token: '', testCode: c.testCode });
  const [busy, setBusy] = useState(false);
  async function save(body, ok) {
    setBusy(true);
    try { onChange(await dash('/integrations/capi', { method: 'PUT', body })); if (ok) toast(ok, 'green'); setF((x) => ({ ...x, token: '' })); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function disconnect() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('in.capi.disconnectConfirm'))) return;
    try { onChange(await dash('/integrations/capi', { method: 'DELETE' })); setF({ pixelId: '', token: '', testCode: '' }); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <Panel t={t} title={t('in.c.capi')} sub={t('in.d.capi')} chip="CA" colour="#1877f2" onClose={onClose}>
      {c.connected ? (
        <div className="in-ok">
          <strong>{t('in.capi.connectedPixel', { id: c.pixelId })}</strong>
          <span>{t('in.capi.okSub')}</span>
          {c.testMode && <small>{t('in.capi.testMode')}</small>}
        </div>
      ) : <p className="small muted">{t('in.capi.how')}</p>}
      {d.canEdit && (
        <div className="in-form">
          <label className="field"><span className="field-label">{t('in.capi.pixel')}</span><input className="input" inputMode="numeric" value={f.pixelId} onChange={(e) => setF({ ...f, pixelId: e.target.value.replace(/\D/g, '') })} placeholder="881200451193" /></label>
          <label className="field"><span className="field-label">{t('in.capi.token')}</span><input className="input" type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={c.connected ? t('in.capi.tokenKept') : 'EAAG…'} /></label>
          <label className="field"><span className="field-label">{t('in.capi.testCode')}</span><input className="input" value={f.testCode} onChange={(e) => setF({ ...f, testCode: e.target.value })} placeholder="TEST12345" /><small className="faint">{t('in.capi.testCodeHint')}</small></label>
          <Button variant="primary" busy={busy} disabled={!f.pixelId || (!c.connected && !f.token)} onClick={() => save({ pixelId: f.pixelId, token: f.token, testCode: f.testCode }, t(c.connected ? 'common.saved' : 'in.capi.connectedToast'))}>{t(c.connected ? 'common.save' : 'in.capi.connect')}</Button>
        </div>
      )}
      <section className="in-sec">
        <h3>{t('in.capi.sendWhen')}</h3>
        <ul className="in-events">
          {EVENT_ORDER.map((k) => (
            <li key={k}>
              <span className="grow"><strong>{t(`in.ev.${k}`)}</strong><small className="muted">{t('in.capi.sentAs', { name: c.names[k], n: t.num(c.sent[k] ?? 0) })}</small></span>
              <Toggle checked={c.events[k]} disabled={!d.canEdit || !c.connected} onChange={(v) => save({ events: { [k]: v } })} label={t(`in.ev.${k}`)} />
            </li>
          ))}
        </ul>
      </section>
      {c.connected && (
        <div className="in-stats">
          <div><small className="muted">{t('in.capi.last')}</small><strong>{c.lastAt ? t.ago(c.lastAt) : '—'}</strong></div>
          <div><small className="muted">{t('in.capi.week')}</small><strong>{t.num(Object.values(c.sent).reduce((a, b) => a + b, 0))}</strong></div>
        </div>
      )}
      {c.lastError && <p className="small in-err">{t('in.capi.lastError', { e: c.lastError })}</p>}
      {c.connected && d.canEdit && <Button className="in-danger" onClick={disconnect}>{t('in.disconnect')}</Button>}
    </Panel>
  );
}

function WidgetPanel({ t, d, onChange, onClose }) {
  const w = d.widget;
  const [f, setF] = useState({ colour: w.colour, greeting: w.greeting, position: w.position });
  const [busy, setBusy] = useState(false);
  async function save(body, ok) {
    setBusy(true);
    try { onChange(await dash('/integrations/widget', { method: 'PUT', body })); if (ok) toast(ok, 'green'); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  const dirty = f.colour !== w.colour || f.greeting !== w.greeting || f.position !== w.position;
  return (
    <Panel t={t} title={t('in.c.widget')} sub={t('in.d.widget')} chip="W" colour="#2b4bff" onClose={onClose}>
      <div className="in-row">
        <span className="grow"><strong>{t('in.w.onLabel')}</strong><small className="muted">{w.on ? t('in.w.chats', { n: t.num(w.chats7d) }) : t('in.w.offSub')}</small></span>
        <Toggle checked={w.on} disabled={!d.canEdit || busy} onChange={(v) => save({ on: v }, v ? t('in.w.onToast') : t('in.w.offToast'))} label={t('in.w.onLabel')} />
      </div>
      {w.setUp && (
        <>
          <section className="in-sec">
            <h3>{t('in.w.code')}</h3>
            <small className="muted">{t('in.w.codeHint')}</small>
            <code className="in-code">{w.snippet}</code>
            <div className="in-row tight">
              <Button size="sm" onClick={() => { navigator.clipboard?.writeText(w.snippet); toast(t('in.w.copied'), 'green'); }}>{t('in.w.copy')}</Button>
              <a className="btn btn-sm" href={w.previewUrl} target="_blank" rel="noreferrer">{t('in.w.preview')}</a>
            </div>
          </section>
          {d.canEdit && (
            <section className="in-sec">
              <h3>{t('in.w.look')}</h3>
              <label className="field"><span className="field-label">{t('in.w.colour')}</span><input type="color" className="in-colour" value={f.colour} onChange={(e) => setF({ ...f, colour: e.target.value })} /></label>
              <label className="field"><span className="field-label">{t('in.w.greeting')}</span><textarea className="input" rows={2} maxLength={200} value={f.greeting} onChange={(e) => setF({ ...f, greeting: e.target.value })} /></label>
              <label className="field"><span className="field-label">{t('in.w.position')}</span>
                <select className="input" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })}><option value="right">{t('in.w.right')}</option><option value="left">{t('in.w.left')}</option></select></label>
              <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => save(f, t('common.saved'))}>{t('common.save')}</Button>
            </section>
          )}
          <p className="small muted">{t('in.w.inbox')}</p>
        </>
      )}
    </Panel>
  );
}

// INT-03 · Shop link: one page with every product shown everywhere, leading into the product page checkout.
function ShopLinkPanel({ t, d, onClose }) {
  const l = d.shopLink;
  return (
    <Panel t={t} title={t('in.c.shoplink')} sub={t('in.d.shoplink')} chip="SL" colour="#111" onClose={onClose}>
      <p className="small">{t('sl.how')}</p>
      <input className="input" readOnly value={l.url} aria-label={t('in.c.shoplink')} onFocus={(e) => e.target.select()} />
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <Button size="sm" onClick={() => navigator.clipboard?.writeText(l.url).then(() => toast(t('sl.copied'), 'green'))}>{t('sl.copyShort')}</Button>
        <a className="btn btn-default btn-sm" href={l.url} target="_blank" rel="noreferrer">{t('sl.open')}</a>
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>{l.products ? t('sl.count', { n: t.num(l.products) }) : t('sl.none')}</p>
      <p className="small muted">{t('sl.where')}</p>
    </Panel>
  );
}
