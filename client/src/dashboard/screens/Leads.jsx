import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, useLocation } from '../lib/router.jsx';
import { Button, Empty, ErrorState, Modal, Pill, Skeleton, Tabs, Toggle, toast } from '../ui/kit.jsx';
import { CallbackDialog } from './Growth.jsx';
import './leads.css';

// Phase 3 · Lead pipeline (FUP-05) and "Asked but didn't order" with Win them back (FUP-08).
const COLS = [['new', 'blue'], ['contacted', 'yellow'], ['call_scheduled', 'purple'], ['won', 'green'], ['lost', 'red']];
const REASONS = ['price', 'bought_elsewhere', 'no_reply', 'size', 'delivery_charge', 'cod', 'changed_mind', 'other'];

export default function Leads() {
  const t = useT();
  const { path } = useLocation();
  const tab = path.startsWith('/growth/not-ordered') ? 'not_ordered' : 'pipeline';
  const [counts, setCounts] = useState({ pipeline: null, notOrdered: null });
  const tabs = (
    <Tabs label={t('ld.title')} value={tab} onChange={(k) => navigate(k === 'pipeline' ? '/growth/leads' : '/growth/not-ordered')} items={[
      { key: 'pipeline', label: t('ld.tabPipeline'), count: counts.pipeline ?? undefined },
      { key: 'not_ordered', label: t('ld.tabNotOrdered'), count: counts.notOrdered ?? undefined },
    ]} />
  );
  return (
    <div className="leads">
      <button type="button" className="ld-back" onClick={() => navigate('/growth')}>← {t('nav.growth')}</button>
      {tab === 'pipeline' ? <Pipeline t={t} onCounts={setCounts} tabs={tabs} /> : <NotOrdered t={t} onCounts={setCounts} tabs={tabs} />}
    </div>
  );
}

function Head({ t, right, tabs }) {
  return (
    <>
      <header className="page-head">
        <div><h1>{t('ld.title')}</h1><p className="page-sub">{t('ld.sub')}</p></div>
        {right}
      </header>
      {tabs}
    </>
  );
}

function Pipeline({ t, onCounts, tabs }) {
  const { can } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('month');
  const [agent, setAgent] = useState('');
  const [losing, setLosing] = useState(null);
  const [calling, setCalling] = useState(null);
  const load = useCallback(() => dash(`/growth/pipeline?period=${period}${agent ? `&agent=${agent}` : ''}`).then((x) => {
    setD(x);
    onCounts((c) => ({ ...c, pipeline: x.columns.new.count + x.columns.contacted.count + x.columns.call_scheduled.count, notOrdered: x.notOrdered }));
  }, setError), [period, agent, onCounts]);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('ld.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={420} r={12} />;
  const k = d.kpis;
  async function move(card, stage, reason) {
    try { await dash(`/growth/leads/${card.id}/stage`, { method: 'POST', body: { stage, reason } }); toast(t(`ld.moved.${stage}`), 'green'); load(); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <>
      <Head t={t} tabs={tabs} right={(
        <div className="row" style={{ gap: 8 }}>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label={t('ld.agent')}>
            <option value="">{t('ld.allAgents')}</option>
            {d.team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label={t('ld.period')}>
            {['week', 'month', 'all'].map((p) => <option key={p} value={p}>{t(`ld.p.${p}`)}</option>)}
          </select>
        </div>
      )} />
      <div className="ld-kpis">
        <div><small>{t(`ld.k.new.${period}`)}</small><strong>{t.num(k.newCount)}</strong></div>
        <div><small>{t('ld.k.won')}</small><strong className="green">{t.num(k.won)} · {t.pct(k.wonPct)}</strong></div>
        <div><small>{t('ld.k.lost')}</small><strong className="red">{t.num(k.lost)}</strong></div>
        <div><small>{t('ld.k.topLost')}</small><strong>{k.topLost ? t(`ld.r.${k.topLost}`) : '—'}</strong></div>
        <div><small>{t('ld.k.closer')}</small><strong>{k.bestCloser ? `${k.bestCloser.name} · ${t.pct(k.bestCloser.rate)}` : '—'}</strong></div>
      </div>
      {!k.newCount ? <Empty icon="growth" title={t('ld.empty')}>{t('ld.emptyHint')}</Empty> : (
        <div className="ld-board">
          {COLS.map(([key, tone]) => {
            const col = d.columns[key];
            return (
              <section key={key} className="ld-col" aria-label={t(`ld.c.${key}`)}>
                <header><span className={`ld-dot tone-${tone}`} /><strong>{t(`ld.c.${key}`)}</strong><span className="grow" /><small className="muted">{t.num(col.count)} · {t.money(col.value)}</small></header>
                <ul>
                  {col.items.map((c) => <Card key={c.id} t={t} c={c} can={can} onMove={move} onLose={() => setLosing(c)} onCall={() => setCalling(c)} />)}
                  {col.count > col.items.length && <li className="muted small ld-more">{t('ld.more', { n: t.num(col.count - col.items.length) })}</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {d.closers.length > 1 && (
        <div className="card ld-closers">
          <h3>{t('ld.perAgent')}</h3>
          <table><thead><tr><th>{t('ld.agent')}</th><th>{t('ld.k.won')}</th><th>{t('ld.decided')}</th><th>{t('ld.rate')}</th></tr></thead>
            <tbody>{d.closers.map((c) => <tr key={c.id}><td>{c.name}</td><td>{t.num(c.won)}</td><td>{t.num(c.decided)}</td><td>{t.pct(c.rate)}</td></tr>)}</tbody></table>
        </div>
      )}
      {losing && <LostDialog t={t} card={losing} onClose={() => setLosing(null)} onDone={(reason) => { const c = losing; setLosing(null); move(c, 'lost', reason); }} />}
      {calling && <CallbackDialog t={t} lead={calling} onClose={() => setCalling(null)} onDone={() => { setCalling(null); load(); }} />}
    </>
  );
}

function Card({ t, c, can, onMove, onLose, onCall }) {
  const chip = c.stage === 'won' ? (c.orderNumber ? { tone: 'green', text: t('ld.order', { n: c.orderNumber }) } : { tone: 'green', text: t('ld.wonChip') })
    : c.stage === 'lost' ? { tone: 'red', text: t(`ld.r.${c.lostReason || 'other'}`) }
      : c.stage === 'call_scheduled' && c.callbackAt ? { tone: 'purple', text: t('ld.callAt', { when: t.date(c.callbackAt) }) }
        : c.winbackAt ? { tone: 'yellow', text: t('ld.winbackSent') }
          : c.temp === 'hot' ? { tone: 'red', text: t('ld.hot') } : c.whyStopped ? { tone: 'blue', text: c.whyStopped } : null;
  const open = ['new', 'contacted', 'call_scheduled'].includes(c.stage);
  return (
    <li className="ld-card">
      <div className="row"><strong className="grow">{c.name}</strong><small className="muted">{t.ago(c.lastSeenAt)}</small></div>
      {c.product && <small className="muted">{c.product}{c.amount ? ` · ${t.money(c.amount)}` : ''}</small>}
      {chip && <span className={`ld-chip tone-${chip.tone}`}>{chip.text}</span>}
      <div className="row ld-foot">
        <span className="ld-owner">{c.owner ? c.owner : c.wonBy === 'page' ? t('ld.page') : 'AI'}</span>
        <span className="grow" />
        {c.conversationId && <button type="button" className="ld-link" onClick={() => navigate(`/inbox/${c.conversationId}`)}>{t('ld.chat')}</button>}
        {open && can('reply') && c.stage === 'contacted' && <button type="button" className="ld-link" onClick={onCall}>{t('ld.scheduleCall')}</button>}
        {can('reply') && (
          <select className="ld-move" value="" onChange={(e) => { if (e.target.value === 'lost') onLose(); else if (e.target.value) onMove(c, e.target.value); }} aria-label={t('ld.moveTo', { name: c.name })}>
            <option value="">{t('ld.move')}</option>
            {['new', 'contacted', 'won', 'lost'].filter((s) => s !== c.stage).map((s) => <option key={s} value={s}>{t(`ld.c.${s}`)}</option>)}
          </select>
        )}
      </div>
    </li>
  );
}

function LostDialog({ t, card, onClose, onDone }) {
  const [reason, setReason] = useState('price');
  return (
    <Modal title={t('ld.lostTitle', { name: card.name })} onClose={onClose} width={420}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => onDone(reason)}>{t('ld.markLost')}</Button></>}>
      <div className="ld-reasons" role="radiogroup" aria-label={t('ld.lostWhy')}>
        {REASONS.map((r) => <label key={r} className={`ld-reason${reason === r ? ' on' : ''}`}><input type="radio" name="lost" checked={reason === r} onChange={() => setReason(r)} />{t(`ld.r.${r}`)}</label>)}
      </div>
    </Modal>
  );
}

function NotOrdered({ t, onCounts, tabs }) {
  const { can } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [offer, setOffer] = useState({ kind: 'free_delivery', value: 10, hours: 24 });
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dash('/growth/not-ordered').then((x) => { setD(x); onCounts((c) => ({ ...c, notOrdered: x.items.length })); }, setError), [onCounts]);
  useEffect(() => { load(); }, [load]);
  const first = d?.items.find((x) => sel.has(x.id));
  useEffect(() => {
    dash('/growth/winback/preview', { method: 'POST', body: { ...offer, product: first?.product ?? '' } }).then((r) => setPreview(r.text), () => {});
  }, [offer, first?.product]);
  if (error) return <ErrorState thing={t('ld.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={420} r={12} />;
  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const nowCount = d.items.filter((x) => sel.has(x.id) && x.canMessageNow).length;
  async function send() {
    setBusy(true);
    try {
      const r = await dash('/growth/winback', { method: 'POST', body: { ids: [...sel], ...offer } });
      toast(t('ld.wbDone', { sent: t.num(r.sent), later: t.num(r.later) }), 'green');
      setSel(new Set());
      load();
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(false); }
  }
  async function saveAuto(auto) {
    try { const s = await dash('/growth/winback/settings', { method: 'PUT', body: { ...offer, auto } }); setD((x) => ({ ...x, settings: s })); toast(t(auto ? 'ld.autoOn' : 'ld.autoOff'), 'green'); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <>
      <Head t={t} tabs={tabs} />
      <div className="ld-split">
        {d.items.length ? (
          <div className="card ld-table">
            <table>
              <thead><tr><th aria-label={t('ld.select')} /><th>{t('ld.customer')}</th><th>{t('ld.askedAbout')}</th><th>{t('ld.times')}</th><th>{t('ld.why')}</th><th>{t('ld.lastSeen')}</th></tr></thead>
              <tbody>{d.items.map((x) => (
                <tr key={x.id} className={sel.has(x.id) ? 'on' : ''}>
                  <td><input type="checkbox" className="ld-check" checked={sel.has(x.id)} onChange={() => toggle(x.id)} aria-label={t('ld.selectName', { name: x.name })} /></td>
                  <td><strong>{x.name}</strong><small className="muted">{x.channel ? t(`bk.plat.${x.channel}`) : ''}{x.hasOffer ? ` · ${t('ld.hasOffer')}` : ''}</small></td>
                  <td>{x.product || '—'}</td>
                  <td><span className={`ld-chip tone-${x.timesAsked >= 3 ? 'orange' : 'gray'}`}>{t('ld.asked', { n: x.timesAsked })}</span></td>
                  <td className="muted">{x.whyStopped || '—'}</td>
                  <td className="muted">{t.ago(x.lastSeenAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty icon="growth" title={t('ld.noneLost')}>{t('ld.noneLostHint')}</Empty>}
        <aside className="card ld-wb">
          <h3>{t('ld.wbTitle')}</h3>
          <p className="small muted">{t('ld.wbHow', { n: t.num(sel.size) })}</p>
          <div className="field"><label htmlFor="wb-kind">{t('ld.offer')}</label>
            <select id="wb-kind" value={offer.kind} onChange={(e) => setOffer((o) => ({ ...o, kind: e.target.value }))}>
              <option value="free_delivery">{t('ld.o.free_delivery')}</option><option value="percent">{t('ld.o.percent')}</option><option value="amount">{t('ld.o.amount')}</option>
            </select>
          </div>
          {offer.kind !== 'free_delivery' && <div className="field"><label htmlFor="wb-val">{t(offer.kind === 'percent' ? 'ld.pctOff' : 'ld.takaOff')}</label><input id="wb-val" type="number" min={1} value={offer.value} onChange={(e) => setOffer((o) => ({ ...o, value: Number(e.target.value) }))} /></div>}
          <div className="field"><label htmlFor="wb-hours">{t('ld.endsIn')}</label>
            <select id="wb-hours" value={offer.hours} onChange={(e) => setOffer((o) => ({ ...o, hours: Number(e.target.value) }))}>{[6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{t('ld.hours', { n: h })}</option>)}</select>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Toggle checked={d.settings.auto} onChange={saveAuto} label={t('ld.auto')} disabled={!can('reply')} /><span className="small">{t('ld.auto')}</span>
          </div>
          {preview && <p className="ld-preview bn-ok">{preview}</p>}
          <Button variant="primary" className="ld-send" busy={busy} disabled={!sel.size || !can('reply')} onClick={send}>{t('ld.send', { n: t.num(sel.size) })}</Button>
          <small className="muted">{sel.size ? t('ld.window', { now: t.num(nowCount), later: t.num(sel.size - nowCount) }) : t('ld.windowHint')}</small>
        </aside>
      </div>
    </>
  );
}
