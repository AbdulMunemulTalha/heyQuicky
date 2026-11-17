import { useCallback, useEffect, useRef, useState } from 'react';
import { dash, downloadFile, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Empty, ErrorState, Kpi, Modal, Pill, Skeleton, toast } from '../ui/kit.jsx';
import './orders.css';

const STAGES = ['pending', 'on_hold', 'approved', 'processing', 'ready_to_ship', 'in_transit', 'delivered', 'cancelled'];
export const STATUS_TONE = { pending: 'yellow', on_hold: 'red', approved: 'gray', processing: 'purple', ready_to_ship: 'blue', in_transit: 'blue', delivered: 'green', cancelled: 'gray', returned: 'orange' };
const SOURCE_TONE = { ai: 'blue', team: 'yellow', product_page: 'purple', website: 'gray' };
const RISK_TONE = { low: 'green', medium: 'yellow', high: 'red' };
export const CANCEL_REASONS = ['customer_cancelled', 'fake_order', 'out_of_stock', 'duplicate', 'other'];

// Screen 03: every order in one place, with KPI tiles, filters, inline status and courier booking.
export default function Orders({ query }) {
  const t = useT();
  const { socket, can, me } = useDash();
  const status = STAGES.includes(query.status) ? query.status : 'all';
  const [q, setQ] = useState(query.q ?? '');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState([]);
  const [cancelFor, setCancelFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const filters = { status, source: query.source ?? '', zone: query.zone ?? '', range: query.range ?? '7d', page: query.page ?? '1' };

  const params = () => new URLSearchParams(Object.entries({ ...filters, q }).filter(([, v]) => v && v !== 'all'));
  const load = useCallback(async () => {
    try { setData(await dash(`/orders?${params()}`)); setError(null); } catch (err) { setError(err); }
  }, [status, filters.source, filters.zone, filters.range, filters.page, q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const timer = setTimeout(load, q ? 250 : 0); return () => clearTimeout(timer); }, [load, q]);
  useEffect(() => { setSelected([]); }, [status, filters.source, filters.zone, filters.range]);
  useEffect(() => {
    if (!socket) return undefined;
    let timer;
    const on = () => { clearTimeout(timer); timer = setTimeout(load, 500); };
    socket.on('order', on);
    return () => { clearTimeout(timer); socket.off('order', on); };
  }, [socket, load]);

  async function setStatus(row, to, extra = {}) {
    if (to === 'cancelled' && !extra.reason) { setCancelFor(row); return; }
    try {
      await dash(`/orders/${row.id}/status`, { method: 'POST', body: { status: to, ...extra } });
      toast(t('ord.statusChanged', { n: row.number, status: t(`status.${to}`) }));
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  async function book(ids, courier = data.couriers[0] ?? 'steadfast') {
    setBusy(true);
    try {
      const r = await dash('/orders/book', { method: 'POST', body: { ids, courier } });
      const failed = r.results.filter((x) => !x.ok);
      toast(failed.length ? failed[0].error : t('ord.booked', { n: r.booked, courier: t(`courier.${courier}`) }), failed.length ? 'red' : 'green');
      setSelected([]);
      load();
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(false); }
  }

  async function printLabels(ids) {
    // Fetch the sheet with the session token, then print it from a new window.
    const win = window.open('', '_blank');
    try {
      const res = await fetch('/api/dash/orders/labels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ ids }) });
      const html = await res.text();
      if (!res.ok) throw new Error(JSON.parse(html).error);
      win.document.write(html);
      win.document.close();
    } catch (err) { win?.close(); toast(err.message, 'red'); }
  }

  const items = data?.items ?? [];
  const k = data?.kpis;
  const allChecked = items.length > 0 && selected.length === items.length;
  const courierName = t(`courier.${data?.couriers[0] ?? 'steadfast'}`);

  return (
    <div className="orders">
      <header className="page-head">
        <div><h1>{t('nav.orders')}</h1><p className="page-sub">{t('ord.sub')}</p></div>
        <div className="page-actions">
          <Button onClick={() => downloadFile(`/orders.csv?${params()}`, 'heyquicky-orders.csv').catch((e) => toast(e.message, 'red'))}>{t('common.exportCsv')}</Button>
          <Button onClick={() => printLabels(selected)}>{t('ord.printLabels')}</Button>
          {can('edit_orders') && <Button variant="primary" icon="plus" onClick={() => navigate('/orders/new')}>{t('ov.newOrder')}</Button>}
        </div>
      </header>

      <div className="kpis ord-kpis">
        {!k ? Array.from({ length: 5 }, (_, i) => <div className="kpi" key={i}><Skeleton w="50%" h={12} /><Skeleton w="60%" h={24} /></div>) : (
          <>
            <Kpi label={t('ord.kpi.today')} value={<>{t.num(k.today)} · {t.money(k.todayRevenue)}</>} />
            <Kpi label={t('ord.kpi.toConfirm')} value={t.num(k.toConfirm)} onClick={() => setQuery({ status: 'pending', page: null })} />
            <Kpi label={t('ord.kpi.ready')} value={t.num(k.ready)} onClick={() => setQuery({ status: 'ready_to_ship', page: null })} />
            <Kpi label={t('ord.kpi.cod')} value={t.money(k.cod)} />
            <Kpi label={t('ord.kpi.returns')} value={<>{t.num(k.returns7)} <small className="kpi-inline">{t.digits(k.returnRate)}%</small></>} onClick={() => navigate('/orders/money?tab=returns')} />
          </>
        )}
      </div>

      <section className="card card-flush">
        <div className="tabs ord-tabs" role="tablist" aria-label={t('ord.byStatus')}>
          {['all', ...STAGES].map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} className={status === s ? 'on' : ''} onClick={() => setQuery({ status: s === 'all' ? null : s, page: null })}>
              {s === 'all' ? t('common.all') : t(`status.${s}`)} <span className="tab-count">{data ? t.num(data.counts[s] ?? 0) : ''}</span>
            </button>
          ))}
        </div>
        <div className="ord-filters">
          <div className="ib-search ord-search"><Icon name="search" size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ord.search')} aria-label={t('ord.search')} /></div>
          <Select label={t('ord.source')} value={filters.source} onChange={(v) => setQuery({ source: v || null, page: null })}
            options={[['', t('common.all')], ['ai', 'AI'], ['team', t('ord.src.team')], ['product_page', t('ord.src.product_page')], ['website', t('ord.src.website')]]} />
          <Select label={t('ord.zone')} value={filters.zone} onChange={(v) => setQuery({ zone: v || null, page: null })}
            options={[['', t('common.all')], ['inside_dhaka', t('zone.inside_dhaka')], ['dhaka_suburbs', t('zone.dhaka_suburbs')], ['outside_dhaka', t('zone.outside_dhaka')]]} />
          <Select value={filters.range} onChange={(v) => setQuery({ range: v === '7d' ? null : v, page: null })}
            options={[['today', t('range.today')], ['7d', t('range.7d')], ['30d', t('range.30d')], ['all', t('range.all')]]} />
          <span className="grow" />
          {selected.length > 0 && (
            <div className="ord-selbar" role="toolbar">
              <span>{t('inbox.selected', { n: selected.length })}</span>
              {can('book_couriers') && <button type="button" className="sel-yellow" disabled={busy} onClick={() => book(selected)}>{t('ord.bookWith', { courier: courierName })}</button>}
              <button type="button" onClick={() => printLabels(selected)}>{t('ord.printLabels')}</button>
            </div>
          )}
        </div>

        {error ? <ErrorState thing={t('nav.orders')} error={error} onRetry={load} supportEmail={me.support.email} /> : (
          <div className="table-wrap">
            <table className="table ord-table">
              <thead>
                <tr>
                  <th className="w-check"><input type="checkbox" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? items.map((i) => i.id) : [])} aria-label={t('inbox.selectAll')} /></th>
                  <th>{t('ord.col.order')}</th><th>{t('ord.col.customer')}</th><th>{t('ord.col.items')}</th><th>{t('ord.col.total')}</th>
                  <th>{t('ord.source')}</th><th>{t('ord.zone')}</th><th>{t('ord.col.risk')}</th><th>{t('ord.col.status')}</th><th>{t('ord.col.courier')}</th>
                </tr>
              </thead>
              <tbody>
                {!data ? Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={10}><Skeleton h={28} /></td></tr>)
                  : items.length === 0 ? (
                    <tr><td colSpan={10}>{q || filters.source || filters.zone || status !== 'all'
                      ? <Empty icon="search" tone="gray" title={t('ord.noMatch', { q })} actions={<Button onClick={() => { setQ(''); navigate('/orders'); }}>{t('ord.clear')}</Button>}>{t('ord.noMatchSub')}</Empty>
                      : <Empty icon="orders" tone="yellow" title={t('ord.emptyTitle')} actions={<>{can('edit_orders') && <Button onClick={() => navigate('/orders/new')}>+ {t('ov.newOrder')}</Button>}<Button variant="primary" onClick={() => navigate('/catalog')}>{t('ord.shareLink')}</Button></>}>{t('ord.emptySub')}</Empty>}
                    </td></tr>
                  ) : items.map((o) => (
                    <tr key={o.id} className={selected.includes(o.id) ? 'selected-row' : ''} onClick={(e) => { if (!e.target.closest('button, input, select, a')) navigate(`/orders/${o.number}`); }}>
                      <td className="w-check"><input type="checkbox" checked={selected.includes(o.id)} aria-label={t('ord.selectOrder', { n: o.number })}
                        onChange={(e) => setSelected((s) => (e.target.checked ? [...s, o.id] : s.filter((x) => x !== o.id)))} /></td>
                      <td><a href={`/app/orders/${o.number}`} onClick={(e) => { e.preventDefault(); navigate(`/orders/${o.number}`); }} className="strong">#{t.digits(o.number)}</a><span className="sub">{t.ago(o.at)}</span></td>
                      <td><strong>{o.name}</strong><span className="sub num">{t.digits(o.phone)}</span>
                        {o.detailsChanged ? <Pill tone="orange">{t('ord.detailsUpdated')}</Pill>
                          : o.orders > 1 && <Pill tone="green">{o.vip ? `VIP · ` : ''}{t('ord.nOrders', { n: o.orders })}</Pill>}</td>
                      <td className="ord-items">{o.items}</td>
                      <td><strong className="num">{t.money(o.total)}</strong>
                        <span className="sub">{o.paid ? t('ord.paid') : o.advance ? t('ord.advance', { a: t.money(o.advance) }) : 'COD'}{o.coupon && ` · ${o.coupon}`}</span></td>
                      <td><Pill tone={SOURCE_TONE[o.source]}>{o.source === 'ai' ? 'AI' : t(`ord.src.${o.source}`)}</Pill></td>
                      <td className="nowrap">{t(`zone.${o.zone}`)}</td>
                      <td><Pill tone={RISK_TONE[o.risk]}>{t(`risk.${o.risk}`)}</Pill></td>
                      <td><StatusPicker t={t} row={o} disabled={!can('edit_orders')} onPick={(to) => setStatus(o, to)} /></td>
                      <td className="nowrap">{o.consignment ? <span className="small muted">{o.courier} {o.consignment}</span>
                        : ['approved', 'processing', 'ready_to_ship'].includes(o.status) && can('book_couriers')
                          ? <Button size="sm" onClick={() => book([o.id])} disabled={busy}>{t('ord.book')}</Button> : <span className="faint">—</span>}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > data.perPage && (
          <footer className="ord-pager">
            <span className="small muted">{t('ord.showing', { from: (data.page - 1) * data.perPage + 1, to: Math.min(data.page * data.perPage, data.total), total: data.total })}</span>
            <Button size="sm" disabled={data.page <= 1} onClick={() => setQuery({ page: data.page - 1 })}>{t('common.back')}</Button>
            <Button size="sm" disabled={data.page * data.perPage >= data.total} onClick={() => setQuery({ page: data.page + 1 })}>{t('ord.next')}</Button>
          </footer>
        )}
      </section>
      {cancelFor && <CancelDialog t={t} order={cancelFor} onClose={() => setCancelFor(null)} onCancel={async (reason, restock) => { await setStatus(cancelFor, 'cancelled', { reason, restock }); setCancelFor(null); }} />}
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="ord-select">
      {label && <span>{label}:</span>}
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

// The status pill doubles as a menu of the moves allowed from this stage.
function StatusPicker({ t, row, onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const can = !disabled && row.next.length > 0;
  return (
    <span className="status-pick" ref={ref}>
      <button type="button" className={`pill pill-${STATUS_TONE[row.status]} pill-btn`} disabled={!can} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>{t(`status.${row.status}`)}{can && ' ▾'}</button>
      {open && (
        <ul className="status-menu" role="menu">
          {row.next.map((s) => <li key={s}><button type="button" role="menuitem" onClick={() => { setOpen(false); onPick(s); }}><span className={`dot ${STATUS_TONE[s] === 'gray' ? 'gray' : STATUS_TONE[s]}`} />{t(`status.${s}`)}</button></li>)}
        </ul>
      )}
    </span>
  );
}

// Frame 11c: cancel with a reason (OMS-06).
export function CancelDialog({ t, order, onClose, onCancel, tellCustomer = false }) {
  const [reason, setReason] = useState('customer_cancelled');
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('ord.cancelTitle', { n: order.number })} subtitle={t('ord.cancelSub')} onClose={onClose} width={440}
      footer={<><Button onClick={onClose}>{t('ord.keepOrder')}</Button><Button variant="danger-solid" busy={busy} onClick={async () => { setBusy(true); await onCancel(reason, restock); setBusy(false); }}>{t('ord.cancelOrder')}</Button></>}>
      <div className="reason-list" role="radiogroup">
        {CANCEL_REASONS.map((r) => (
          <label key={r} className={`reason${reason === r ? ' on-r' : ''}`}>
            <input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} />{t(`cancel.${r}`)}
          </label>
        ))}
      </div>
      <label className="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
        <span className="check-box" aria-hidden="true"><Icon name="check" size={12} /></span>
        <span className="check-text">{t('ord.putBack')}</span>
      </label>
      {tellCustomer}
    </Modal>
  );
}
