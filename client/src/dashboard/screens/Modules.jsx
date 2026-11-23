import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Button, ErrorState, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import './modules.css';

const ICON = { inbox: '💬', orders: '🧾', courier: '📦', catalog: '🏷️', growth: '📈', coupons: '🎟️', payments: '💳', tickets: '🎫', bookings: '📅', quotes: '📝', content: '✍️', analytics: '📊' };
const ORDER = ['inbox', 'orders', 'courier', 'catalog', 'growth', 'coupons', 'payments', 'tickets', 'bookings', 'quotes', 'content', 'analytics'];

// Phase 2 · Modules by business type (UX-07), frame "Modules by business type".
export default function Modules() {
  const t = useT();
  const { reload } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dash('/settings/modules').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  async function patch(body, ok) {
    setBusy(true);
    try { setD(await dash('/settings/modules', { method: 'PATCH', body })); if (ok) toast(ok, 'green'); reload?.(); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  if (error) return <ErrorState thing={t('md.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={420} r={12} />;
  const edit = d.canEdit;
  const type = t(`md.type.${d.businessType}`);
  const byKey = new Map(d.modules.map((m) => [m.key, m]));
  const offRec = ORDER.filter((k) => byKey.get(k) && !byKey.get(k).always && !byKey.get(k).recommended);
  const onRec = ORDER.filter((k) => byKey.get(k)?.recommended && !byKey.get(k).notBuilt);
  return (
    <div className="modules">
      <button type="button" className="md-back" onClick={() => navigate('/settings')}>← {t('nav.settings')}</button>
      <header className="page-head">
        <div><h1>{t('md.title')}</h1><p className="page-sub">{t('md.sub')}</p></div>
        <label className="md-type">
          <span className="small muted">{t('md.businessType')}</span>
          <select className="input" value={d.businessType} disabled={!edit || busy} onChange={(e) => patch({ businessType: e.target.value })}>
            {d.businessTypes.map((k) => <option key={k} value={k}>{t(`md.type.${k}`)}</option>)}
          </select>
        </label>
      </header>
      <div className="md-banner">
        <span><strong>{t('md.recFor', { type })}</strong> {t('md.recLine', { off: offRec.map((k) => t(`md.m.${k}`)).join(', ') || '—', on: onRec.map((k) => t(`md.m.${k}`)).join(', ') || '—' })}</span>
        {edit && <Button size="sm" disabled={busy || d.matchesRecommended} onClick={() => patch({ useRecommended: true }, t('md.usedRec'))}>{d.matchesRecommended ? t('md.usingRec') : t('md.useRec')}</Button>}
      </div>
      <div className="md-grid">
        {ORDER.filter((k) => byKey.has(k)).map((k) => {
          const m = byKey.get(k);
          const dim = !m.always && !m.on;
          return (
            <div key={k} className={`card md-card${dim ? ' off' : ''}`}>
              <div className="md-top">
                <span className="md-ico" aria-hidden="true">{ICON[k]}</span>
                {m.always ? <Pill tone="gray">{t('md.alwaysOn')}</Pill>
                  : m.notBuilt ? <Toggle checked={false} disabled label={t(`md.m.${k}`)} />
                    : <Toggle checked={m.on} disabled={!edit || busy} onChange={(on) => patch({ modules: { [k]: on } }, on ? t('md.turnedOn', { m: t(`md.m.${k}`) }) : t('md.turnedOff', { m: t(`md.m.${k}`) }))} label={t(`md.m.${k}`)} />}
              </div>
              <strong className="md-name">{t(`md.m.${k}`)}</strong>
              <small className="muted">{t(`md.d.${k}`)}</small>
              <span className="md-tags">
                {m.notBuilt && <Pill tone="blue">{t('md.comingLater')}</Pill>}
                {!m.always && m.recommended && !m.notBuilt && <Pill tone="green">{t('md.recommended')}</Pill>}
                {!m.always && !m.recommended && <Pill tone="gray">{t('md.notCommon', { type: type.toLowerCase() })}</Pill>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="small muted md-note">{t('md.note')}</p>
    </div>
  );
}

// Shown instead of a page whose module the shop switched off.
export function ModuleOff({ module }) {
  const t = useT();
  const { can } = useDash();
  return (
    <div className="card md-offpage">
      <span className="md-ico big" aria-hidden="true">{ICON[module] ?? '🧩'}</span>
      <h2>{t('md.offTitle', { m: t(`md.m.${module}`) })}</h2>
      <p className="muted">{t('md.offSub')}</p>
      {can('edit_products') || can('invite') ? <Button variant="primary" onClick={() => navigate('/settings/modules')}>{t('md.openModules')}</Button> : null}
    </div>
  );
}
