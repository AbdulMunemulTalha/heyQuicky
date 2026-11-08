import { useCallback, useEffect, useState } from 'react';
import { api, download } from '../api.js';
import { STATUS_LABEL, taka, timeLabel } from '../format.js';
import { Modal, useSocketEvent } from './common.jsx';

// The orders page: search, status changes and CSV export for courier bulk upload.
export function OrdersDialog({ open, onClose }) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [orders, setOrders] = useState([]);

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (query) params.set('q', query);
  const qs = params.toString();

  const load = useCallback(() => api(`/orders?${qs}`).then(setOrders).catch((err) => alert(err.message)), [qs]);
  useEffect(() => { if (open) load(); }, [open, load]);
  useSocketEvent('order', () => { if (open) load(); });

  async function changeStatus(order, value) {
    try {
      await api(`/orders/${order.id}`, { method: 'PATCH', body: { status: value } });
    } catch (err) {
      alert(err.message);
      load();
    }
  }

  const toCollect = orders.filter((o) => o.status === 'confirmed' || o.status === 'shipped').reduce((s, o) => s + o.cod_amount, 0);

  return (
    <Modal open={open} onClose={onClose} className="wide-dialog">
      <h2>Orders</h2>
      <div className="inline-form">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input type="search" placeholder="Search name, phone or #order" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="ghost" onClick={() => download(`/orders.csv?${qs}`, `orders-${new Date().toISOString().slice(0, 10)}.csv`)
          .catch((err) => alert(err.message))}>Export CSV</button>
      </div>
      <p className="muted small">{orders.length} orders · {taka(toCollect)} COD still to collect</p>
      <div className="table-scroll">
        <table className="table">
          <tbody>
            <tr>{['#', 'Date', 'Customer', 'Phone', 'Address', 'Products', 'COD', 'Taken by', 'Status'].map((h) => <th key={h}>{h}</th>)}</tr>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>#{o.id}</td>
                <td className="muted">{timeLabel(o.created_at)}</td>
                <td>{o.customer_name}</td>
                <td>{o.phone}</td>
                <td>{o.address}{o.area === 'outside_dhaka' ? ' (outside Dhaka)' : ''}</td>
                <td>{o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}</td>
                <td className="num">{taka(o.cod_amount)}</td>
                <td className="muted">{o.created_by_name ?? ''}</td>
                <td>
                  <select value={o.status} onChange={(e) => changeStatus(o, e.target.value)}>
                    {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {!orders.length && <tr><td className="muted" colSpan={9}>No orders yet</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
