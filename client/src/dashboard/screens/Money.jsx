import { useCallback, useEffect, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Empty, ErrorState, Kpi, Pill, Skeleton, Tabs, toast } from '../ui/kit.jsx';
import './money.css';

const CHIP = { steadfast: 'SF', pathao: 'PT', redx: 'RX', paperfly: 'PF', ecourier: 'EC' };
const CASH_TONE = { due_today: 'yellow', due_tomorrow: 'yellow', upcoming: 'gray', late: 'red', received: 'green' };
const TYPE_TONE = { exchange: 'blue', return: 'orange', damaged: 'red' };
const PARCEL_TONE = { coming: 'yellow', picked: 'yellow', back: 'green' };

// Phase 2 · Money & follow-up (OMS-05 / OMS-07): Cash · Returns · To chase.
export default function Money({ path, query }) {
  const t = useT();
  const { socket, can } = useDash();
  const tab = path.startsWith('/orders/chase') ? 'chase' : query.tab === 'returns' ? 'returns' : 'cash';
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash('/money').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('money', load);
    socket.on('order', load);
    return () => { socket.off('money', load); socket.off('order', load); };
  }, [socket, load]);
  const go = (v) => (v === 'chase' ? navigate('/orders/chase') : navigate(`/orders/money${v === 'returns' ? '?tab=returns' : ''}`));
  async function exportCsv() {
    const res = await fetch(`/api/dash/money.csv?tab=${tab}`, { headers: { authorization: `Bearer ${session.token}` } });
    if (!res.ok) { toast(t('mo.exportFailed'), 'red'); return; }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a'); link.href = url; link.download = `money-${tab}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  if (error) return <ErrorState thing={t('mo.title')} error={error} onRetry={load} />;
  const edit = can('edit_orders');
  return (
    <div className="money">
      <button type="button" className="mo-back" onClick={() => navigate('/orders')}>← {t('nav.orders')}</button>
      <header className="page-head">
        <div><h1>{t('mo.title')}</h1><p className="page-sub">{t('mo.sub')}</p></div>
        <div className="page-actions"><Button onClick={exportCsv}>{t('mo.export')}</Button></div>
      </header>
      <Tabs label={t('mo.title')} value={tab} onChange={go} items={[
        { key: 'cash', label: d ? t('mo.tab.cashDue', { n: t.money(d.cash.kpis.withCouriers) }) : t('mo.tab.cash') },
        { key: 'returns', label: t('mo.tab.returns'), count: d?.returns.rows.filter((r) => !r.done).length },
        { key: 'chase', label: t('mo.tab.chase'), count: d?.chase.rows.length },
      ]} />
      {!d ? <Skeleton h={320} r={12} /> : (
        <>
          {tab === 'cash' && <Cash t={t} d={d.cash} edit={edit} onChange={load} />}
          {tab === 'returns' && <Returns t={t} d={d.returns} edit={edit} onChange={load} />}
          {tab === 'chase' && <Chase t={t} rows={d.chase.rows} edit={edit} onChange={load} />}
        </>
      )}
    </div>
  );
}

function range(t, from, to) {
  const a = t.date(from);
  const b = t.date(to);
  return a === b ? a : `${a} – ${b}`;
}

function Cash({ t, d, edit, onChange }) {
  const k = d.kpis;
  async function received(r) {
    try { await dash('/money/payouts', { method: 'POST', body: { key: r.key } }); toast(t('mo.receivedToast', { n: t.money(r.amount), c: r.name }), 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  const status = (r) => (r.status === 'late' ? t('mo.st.late', { n: t.num(r.lateDays) }) : t(`mo.st.${r.status}`));
  return (
    <>
      <div className="mo-kpis">
        <Kpi label={t('mo.k.withCouriers')} value={t.money(k.withCouriers)} sub={t('mo.k.unpaid', { n: t.num(k.unpaidParcels) })} />
        <Kpi label={t('mo.k.dueToday')} value={t.money(k.dueToday)} tone={k.dueToday ? 'yellow' : undefined} sub={k.dueTodayCouriers.join(', ') || t('mo.k.nothingDue')} />
        <Kpi label={t('mo.k.late')} value={t.money(k.late)} tone={k.late ? 'red' : undefined} sub={k.lateNote ? t('mo.k.lateNote', { c: k.lateNote.name, n: t.num(k.lateNote.days) }) : t('mo.k.noneLate')} />
        <Kpi label={t('mo.k.received30')} value={t.money(k.received30)} tone="green" sub={t('mo.k.parcels', { n: t.num(k.received30Parcels) })} />
      </div>
      <div className="card card-flush">
        {d.rows.length === 0 ? <Empty icon="truck" title={t('mo.cashEmpty')}>{t('mo.cashEmptySub')}</Empty> : (
          <div className="mo-tablewrap">
            <table className="mo-table">
              <thead><tr>
                <th scope="col">{t('mo.col.payout')}</th><th scope="col">{t('mo.col.parcels')}</th><th scope="col">{t('mo.col.collected')}</th>
                <th scope="col">{t('mo.col.fees')}</th><th scope="col">{t('mo.col.youGet')}</th><th scope="col">{t('mo.col.status')}</th><th scope="col"><span className="sr-only">{t('cp.actions')}</span></th>
              </tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.key}>
                    <td><span className="mo-who"><span className={`mo-chip c-${r.courier}`} aria-hidden="true">{CHIP[r.courier] ?? r.name.slice(0, 2).toUpperCase()}</span><span><strong>{r.name}</strong><small className="muted">{t('mo.payoutFor', { d: range(t, r.from, r.to) })}</small></span></span></td>
                    <td>{t.num(r.parcels)}</td>
                    <td>{t.money(r.collected)}</td>
                    <td className={r.fees ? 'mo-neg' : 'muted'}>{r.fees ? `−${t.money(r.fees)}` : t.money(0)}</td>
                    <td><strong>{t.money(r.amount)}</strong></td>
                    <td><Pill tone={CASH_TONE[r.status]}>{status(r)}</Pill></td>
                    <td className="mo-actions">{r.status !== 'received' && edit && <Button size="sm" onClick={() => received(r)}>{t('mo.markReceived')}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="small muted mo-note">{t('mo.cashNote')}</p>
    </>
  );
}

function Returns({ t, d, edit, onChange }) {
  const k = d.kpis;
  async function act(r, action, ok) {
    try { await dash(`/money/returns/${r.id}`, { method: 'PATCH', body: { action } }); if (ok) toast(ok, 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  // One main button per row, as in the frame.
  const main = (r) => {
    if (r.done) return <span className="mo-done">{t('mo.closed')} ✓</span>;
    if (r.type === 'damaged' && !r.claimed && r.stock !== 'restocked') return <Button size="sm" onClick={() => act(r, 'claim', t('mo.claimedToast'))}>{t('mo.claim')}</Button>;
    if (r.stock === 'waiting') return <Button size="sm" onClick={() => act(r, 'restock', t('mo.restockedToast'))}>{t('mo.restock')}</Button>;
    return <Button size="sm" onClick={() => act(r, 'done')}>{t('mo.done')} ✓</Button>;
  };
  return (
    <>
      <div className="mo-kpis">
        <Kpi label={t('mo.k.rate')} value={`${t.num(k.rate)}%`} tone={k.rate <= 5 ? 'green' : k.rate <= 15 ? 'yellow' : 'red'} />
        <Kpi label={t('mo.k.returns')} value={t.num(k.returns)} />
        <Kpi label={t('mo.k.exchanges')} value={t.num(k.exchanges)} />
        <Kpi label={t('mo.k.lost')} value={t.money(k.lost)} tone={k.lost ? 'red' : undefined} />
      </div>
      <div className="card card-flush">
        {d.rows.length === 0 ? <Empty icon="check" tone="green" title={t('mo.returnsEmpty')}>{t('mo.returnsEmptySub')}</Empty> : (
          <div className="mo-tablewrap">
            <table className="mo-table">
              <thead><tr>
                <th scope="col">{t('mo.col.order')}</th><th scope="col">{t('mo.col.type')}</th><th scope="col">{t('mo.col.reason')}</th>
                <th scope="col">{t('mo.col.parcel')}</th><th scope="col">{t('mo.col.stock')}</th><th scope="col">{t('mo.col.loss')}</th><th scope="col"><span className="sr-only">{t('cp.actions')}</span></th>
              </tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className={r.done ? 'done' : ''}>
                    <td><button type="button" className="mo-link" onClick={() => navigate(`/orders/${r.number}`)}>#{r.number}</button><small className="muted mo-block">{r.customer}</small></td>
                    <td><Pill tone={TYPE_TONE[r.type]}>{t(`mo.type.${r.type}`)}</Pill></td>
                    <td className="bn-ok">{r.reason}</td>
                    <td>
                      {edit && !r.done && r.parcel !== 'back' ? (
                        <select className={`mo-parcel tone-${PARCEL_TONE[r.parcel]}`} value={r.parcel} onChange={(e) => act(r, e.target.value)} aria-label={t('mo.col.parcel')}>
                          {['coming', 'picked', 'back'].map((p) => <option key={p} value={p} disabled={p === 'coming'}>{t(`mo.parcel.${p}`)}</option>)}
                        </select>
                      ) : <Pill tone={PARCEL_TONE[r.parcel]}>{t(`mo.parcel.${r.parcel}`)}</Pill>}
                    </td>
                    <td className="muted">
                      {t(`mo.stock.${r.stock}`)}
                      {edit && !r.done && r.stock === 'waiting' && <> · <button type="button" className="mo-link small" onClick={() => act(r, 'cant_sell')}>{t('mo.cantSell')}</button></>}
                      {r.claimed && <small className="mo-block">{t('mo.claimedNote')}</small>}
                    </td>
                    <td className="mo-neg">{t.money(r.loss)}</td>
                    <td className="mo-actions">{edit && main(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="small muted mo-note">{t('mo.returnsNote')}</p>
    </>
  );
}

function Chase({ t, rows, edit, onChange }) {
  async function result(r, res, ok) {
    try { await dash(`/money/chase/${r.orderId}/result`, { method: 'POST', body: { result: res } }); toast(ok, res === 'cancel' ? undefined : 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  async function whatsapp(r) {
    const num = r.phone.replace(/\D/g, '').replace(/^0/, '880');
    window.open(`https://wa.me/${num}`, '_blank', 'noopener');
    try { await dash(`/money/chase/${r.orderId}/try`, { method: 'POST', body: { kind: 'whatsapp' } }); onChange(); } catch { /* the chat still opened */ }
  }
  const tried = (r) => [r.calls && t(r.calls === 1 ? 'mo.call1' : 'mo.calls', { n: t.num(r.calls) }), r.whatsapps && t('mo.whatsapps', { n: t.num(r.whatsapps) })].filter(Boolean).join(' · ') || t('mo.notTried');
  const when = (r) => {
    if (r.overdue) return t('mo.overdue', { w: t.ago(r.nextAt) });
    const d = new Date(r.nextAt);
    const today = new Date().toDateString() === d.toDateString();
    const tomorrow = new Date(Date.now() + 86_400_000).toDateString() === d.toDateString();
    return `${today ? t('mo.today') : tomorrow ? t('mo.tomorrow') : t.date(r.nextAt)} ${t.time(r.nextAt)}`;
  };
  return (
    <>
      {rows.length > 0 && <div className="alert-bar alert-yellow mo-alert">📞 <strong>{t(rows.length === 1 ? 'mo.chaseBanner1' : 'mo.chaseBanner', { n: t.num(rows.length) })}</strong> {t('mo.chaseBannerSub')}</div>}
      <div className="card card-flush">
        {rows.length === 0 ? <Empty icon="check" tone="green" title={t('mo.chaseEmpty')}>{t('mo.chaseEmptySub')}</Empty> : (
          <div className="mo-tablewrap">
            <table className="mo-table">
              <thead><tr>
                <th scope="col">{t('mo.col.customer')}</th><th scope="col">{t('mo.col.order')}</th><th scope="col">{t('mo.col.tried')}</th>
                <th scope="col">{t('mo.col.next')}</th><th scope="col">{t('mo.col.owner')}</th><th scope="col">{t('mo.col.log')}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.orderId} className={r.overdue ? 'late' : ''}>
                    <td>
                      <strong>{r.customer}</strong>
                      <span className="mo-block mo-contact"><a href={`tel:${r.phone}`} className="muted">{r.phone}</a>{edit && <button type="button" className="mo-wa" onClick={() => whatsapp(r)} title={t('mo.openWhatsapp')}>WhatsApp</button>}</span>
                    </td>
                    <td><button type="button" className="mo-link" onClick={() => navigate(`/orders/${r.number}`)}>#{r.number}</button><small className="muted mo-block">{t.money(r.total)}</small></td>
                    <td>{tried(r)}<small className="muted mo-block bn-ok">{r.reason}</small></td>
                    <td className={r.overdue ? 'mo-late' : ''}><strong>{when(r)}</strong></td>
                    <td>{r.owner || <span className="muted">—</span>}</td>
                    <td className="mo-log">
                      {edit && (
                        <>
                          <Button size="sm" onClick={() => result(r, 'confirmed', t('mo.confirmedToast', { n: r.number }))}>{t('mo.confirmed')}</Button>
                          <Button size="sm" onClick={() => result(r, 'no_answer', t('mo.noAnswerToast'))}>{t('mo.noAnswer')}</Button>
                          <Button size="sm" variant="ghost" className="mo-cancel" onClick={() => {
                            // eslint-disable-next-line no-alert
                            if (window.confirm(t('mo.cancelConfirm', { n: r.number }))) result(r, 'cancel', t('mo.cancelledToast', { n: r.number }));
                          }}>{t('common.cancel')}</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="small muted mo-note">{t('mo.chaseNote')}</p>
    </>
  );
}
