import { useCallback, useEffect, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Link, setQuery } from '../lib/router.jsx';
import { Button, Card, Empty, ErrorState, Kpi, PageHead, Segmented, Skeleton, toast } from '../ui/kit.jsx';
import './analytics.css';

const RANGES = [7, 30, 90];
const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const WHO_TONE = { ai: 'var(--accent)', product_page: '#7c5cdb', website: '#0f9d8a' };
const USER_TONES = ['#f4c430', '#111', '#e07b39', '#5b8def', '#c76b7e'];

function duration(t, sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return t('ov.sec', { n: Math.round(sec) });
  if (sec < 3600) return t('ov.min', { n: Math.round(sec / 60) });
  return t('ov.hour', { n: Math.round(sec / 3600) });
}

// Screen 09: what the AI handled, what it earned, and where orders slip away (ANL-02..08).
export default function Analytics({ query }) {
  const t = useT();
  const range = RANGES.includes(Number(query.range)) ? Number(query.range) : 30;
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const load = useCallback(() => { setD(null); return dash(`/analytics?range=${range}`).then(setD, setError); }, [range]);
  useEffect(() => { load(); }, [load]);

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await fetch(`/api/dash/analytics.csv?range=${range}`, { headers: { authorization: `Bearer ${session.token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `heyquicky-analytics-${range}d.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'red'); } finally { setExporting(false); }
  }

  if (error) return <ErrorState thing={t('nav.analytics')} error={error} onRetry={load} />;
  const k = d?.kpis;
  return (
    <div className="analytics">
      <PageHead title={t('nav.analytics')} sub={t('an.sub')} actions={(
        <>
          <Segmented label={t('an.range')} value={range} onChange={(v) => setQuery({ range: v === 30 ? null : v })} items={RANGES.map((r) => ({ key: r, label: t('an.days', { n: r }) }))} />
          <Button onClick={exportCsv} busy={exporting} disabled={!d}>{t('common.exportCsv')}</Button>
        </>
      )} />

      <div className="an-kpis">
        {!k ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} h={92} r={12} />) : (
          <>
            <Kpi label={t('an.k.revenue')} value={t.money(k.revenue)} sub={k.revenueChange === null ? t('an.noPrev') : t('an.vsPrev', { p: `${k.revenueChange > 0 ? '+' : ''}${t.pct(k.revenueChange)}` })} />
            <Kpi label={t('an.k.orders')} value={t.num(k.orders)} sub={t('an.byAi', { n: t.num(k.ordersByAi) })} />
            <Kpi label={t('an.k.aiOnly')} value={k.aiOnlyPct === null ? '—' : t.pct(k.aiOnlyPct)} sub={t('an.ofChats', { a: t.num(k.aiOnly), b: t.num(k.conversations) })} />
            <Kpi label={t('an.k.perTaka')} value={k.revenuePerTaka === null ? '—' : t.money(k.revenuePerTaka)} sub={t('an.spend', { m: t.money(k.aiSpend, 2) })} />
            <Kpi label={t('an.k.firstReply')} value={duration(t, k.firstReplySec)} sub={k.teamFirstReplySec ? t('an.team', { d: duration(t, k.teamFirstReplySec) }) : t('an.teamNone')} />
            <Kpi label={t('an.k.delivered')} value={k.deliveredPct === null ? '—' : t.pct(k.deliveredPct)} sub={t('an.returns', { p: t.pct(k.returnsPct ?? 0, 1) })} />
          </>
        )}
      </div>

      {d && k.orders === 0 && k.conversations === 0 ? (
        <Card><Empty icon="analytics" title={t('an.emptyTitle')}>{t('an.emptyBody')}</Empty></Card>
      ) : (
        <div className="an-grid">
          <div className="od-col">
            <Card title={t('an.who')} action={<span className="small muted">{t('an.whoHint')}</span>}>
              {!d ? <Skeleton h={180} /> : d.who.length === 0 ? <p className="small muted">{t('an.noOrders')}</p> : <Who t={t} who={d.who} />}
            </Card>
            <Card title={t('an.heat')} action={<span className="small muted">{t('an.heatHint')}</span>}>
              {!d ? <Skeleton h={200} /> : <Heat t={t} heat={d.heat} />}
            </Card>
          </div>
          <div className="od-col">
            <Card title={t('an.cancel')}>
              {!d ? <Skeleton h={150} /> : d.cancelled.total === 0 ? <p className="small muted">{t('an.noCancel')}</p> : (
                <ul className="an-reasons">
                  {d.cancelled.reasons.map((r) => (
                    <li key={r.reason}>
                      <span>{t(`cancel.${r.reason}`)}</span>
                      <span className="an-bar sm"><span style={{ width: `${r.pct}%` }} /></span>
                      <strong>{t.pct(r.pct, 0)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={t('an.couriers')}>
              {!d ? <Skeleton h={120} /> : d.couriers.length === 0 ? <p className="small muted">{t('an.noCouriers')}</p> : (
                <table className="an-table">
                  <thead><tr><th>{t('an.courier')}</th><th>{t('an.booked')}</th><th>{t('an.deliveredCol')}</th><th>{t('an.cod')}</th></tr></thead>
                  <tbody>{d.couriers.map((c) => (
                    <tr key={c.courier}><td><strong>{c.courier.charAt(0).toUpperCase() + c.courier.slice(1)}</strong></td><td>{t.num(c.booked)}</td>
                      <td>{c.deliveredRate === null ? '—' : t.pct(c.deliveredRate, 0)}</td><td>{t.money(c.cod)}</td></tr>
                  ))}</tbody>
                </table>
              )}
              <h3 className="an-sub">{t('an.best')}</h3>
              {!d ? <Skeleton h={80} /> : d.bestSellers.length === 0 ? <p className="small muted">{t('an.noOrders')}</p> : (
                <ul className="an-best">{d.bestSellers.slice(0, 3).map((b) => <li key={b.name}><span className="bn-ok">{b.name}</span><strong>{t.num(b.units)}</strong></li>)}</ul>
              )}
              {d?.interested > 0 && <Link to="/growth?tab=leads" className="an-link">{t('an.interested', { n: t.num(d.interested) })} →</Link>}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Who({ t, who }) {
  const max = Math.max(...who.map((w) => w.orders));
  let u = 0;
  return (
    <ul className="an-who">
      {who.map((w) => {
        const tone = WHO_TONE[w.key] ?? USER_TONES[u++ % USER_TONES.length];
        const label = w.key === 'user' ? w.name || t('an.src.team') : t(`an.src.${w.key}`);
        return (
          <li key={w.key + w.name}>
            <div className="row"><strong className="grow">{label}</strong>
              <span className="small">{t(w.orders === 1 ? 'an.whoLine1' : 'an.whoLine', { n: t.num(w.orders), m: t.money(w.revenue) })}{w.deliveredRate !== null && <span className="muted"> ({t.pct(w.deliveredRate, 0)})</span>}</span></div>
            <span className="an-bar"><span style={{ width: `${(w.orders / max) * 100}%`, background: tone }} /></span>
          </li>
        );
      })}
    </ul>
  );
}

function Heat({ t, heat }) {
  if (!heat.total) return <p className="small muted">{t('an.noMessages')}</p>;
  const level = (n) => (n === 0 ? 0 : Math.min(5, Math.ceil((n / heat.max) * 5)));
  return (
    <>
      <div className="an-heat" role="table" aria-label={t('an.heat')}>
        {heat.grid.map((row, di) => (
          <div key={DAYS[di]} className="an-heat-row" role="row">
            <span className="an-heat-day" role="rowheader">{t(`an.day.${DAYS[di]}`)}</span>
            {row.map((n, h) => <span key={h} role="cell" className={`an-cell l${level(n)}`} title={t('an.cellTitle', { d: t(`an.day.${DAYS[di]}`), h: hourLabel(t, h), n: t.num(n) })} />)}
          </div>
        ))}
        <div className="an-heat-row an-heat-axis" aria-hidden>
          <span className="an-heat-day" />
          {Array.from({ length: 24 }, (_, h) => <span key={h} className="an-axis">{[0, 6, 12, 18, 23].includes(h) ? hourLabel(t, h) : ''}</span>)}
        </div>
      </div>
      {heat.lateNightPct !== null && <p className="small muted an-note">{t('an.lateNight', { p: t.pct(heat.lateNightPct, 0) })}</p>}
    </>
  );
}

// "6 PM" in English, "সন্ধ্যা ৬টা" in Bangla: Bangla names the part of the day instead of AM/PM.
function hourLabel(t, h) {
  const part = h < 5 ? 'late' : h < 12 ? 'morning' : h < 16 ? 'noon' : h < 19 ? 'evening' : 'night';
  return t(`an.h.${part}`, { n: h % 12 === 0 ? 12 : h % 12 });
}
