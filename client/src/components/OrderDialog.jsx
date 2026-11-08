import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { taka } from '../format.js';
import { ErrorText, Modal } from './common.jsx';

const PAYMENT_METHODS = [['cod', 'Cash on delivery'], ['bkash', 'bKash'], ['nagad', 'Nagad'], ['rocket', 'Rocket'], ['bank', 'Bank']];

const emptyItem = () => ({ key: Math.random(), name: '', qty: 1, price: '' });

// "New order" from a chat, pre-filled from what is known about the customer.
export function OrderDialog({ open, conversationId, workspace, onClose }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const defaultDelivery = (area) => (area === 'inside_dhaka' ? workspace.deliveryInsideDhaka : workspace.deliveryOutsideDhaka);

  useEffect(() => {
    if (!open) { setForm(null); return; }
    setError('');
    api(`/conversations/${conversationId}/orders`).then(({ draft }) => setForm({
      customerName: draft.customerName,
      phone: draft.phone,
      address: draft.address,
      area: draft.area,
      paymentMethod: 'cod',
      items: [emptyItem()],
      deliveryCharge: String(defaultDelivery(draft.area)),
      discount: '0',
      advancePaid: '0',
      note: '',
      sendSummary: true,
    })).catch((err) => { alert(err.message); onClose(); });
  }, [open, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (field) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({
      ...f,
      [field]: value,
      // Changing the area switches to that area's delivery charge.
      ...(field === 'area' ? { deliveryCharge: String(defaultDelivery(value)) } : {}),
    }));
  };
  const setItem = (key, field) => (e) => setForm((f) => ({
    ...f, items: f.items.map((item) => (item.key === key ? { ...item, [field]: e.target.value } : item)),
  }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const { summaryError } = await api(`/conversations/${conversationId}/orders`, {
        method: 'POST',
        body: {
          customerName: form.customerName,
          phone: form.phone,
          address: form.address,
          area: form.area,
          paymentMethod: form.paymentMethod,
          items: form.items.map((i) => ({ name: i.name, qty: Number(i.qty || 0), price: Number(i.price || 0) })),
          deliveryCharge: form.deliveryCharge === '' ? null : Number(form.deliveryCharge),
          discount: Number(form.discount || 0),
          advancePaid: Number(form.advancePaid || 0),
          note: form.note,
          sendSummary: form.sendSummary,
        },
      });
      onClose();
      if (summaryError) alert(`Order saved, but the summary was not sent: ${summaryError}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  let totals = null;
  if (form) {
    const subtotal = form.items.reduce((sum, i) => sum + Number(i.qty || 0) * Number(i.price || 0), 0);
    const delivery = Number(form.deliveryCharge || 0);
    const discount = Number(form.discount || 0);
    const advance = Number(form.advancePaid || 0);
    const cod = subtotal + delivery - discount - advance;
    totals = [
      ['Products', taka(subtotal)],
      ['Delivery', taka(delivery)],
      discount ? ['Discount', `−${taka(discount)}`] : null,
      advance ? ['Advance paid', `−${taka(advance)}`] : null,
      ['Cash on delivery', cod < 0 ? '—' : taka(cod), 'cod'],
    ].filter(Boolean);
  }

  return (
    <Modal open={open && Boolean(form)} onClose={onClose}>
      <h2>New order</h2>
      {form && (
        <form className="order-form" onSubmit={submit}>
          <label className="field">Customer name<input value={form.customerName} onChange={set('customerName')} required /></label>
          <label className="field">Phone<input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="01XXXXXXXXX" required /></label>
          <label className="field wide">Address<textarea value={form.address} onChange={set('address')} rows={2} required /></label>
          <label className="field">Area
            <select value={form.area} onChange={set('area')}>
              <option value="inside_dhaka">Inside Dhaka</option>
              <option value="outside_dhaka">Outside Dhaka</option>
            </select>
          </label>
          <label className="field">Payment
            <select value={form.paymentMethod} onChange={set('paymentMethod')}>
              {PAYMENT_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <div className="wide">
            <div className="items-head muted small"><span>Product</span><span>Qty</span><span>Price (৳)</span><span /></div>
            <div>
              {form.items.map((item, i) => (
                <div className="item-row" key={item.key}>
                  <input value={item.name} onChange={setItem(item.key, 'name')} placeholder="e.g. Red kurti (M)" required autoFocus={i === 0} />
                  <input value={item.qty} onChange={setItem(item.key, 'qty')} type="number" min="1" step="1" required />
                  <input value={item.price} onChange={setItem(item.key, 'price')} type="number" min="0" step="1" required />
                  <button type="button" className="ghost" title="Remove"
                    onClick={() => setForm((f) => ({ ...f, items: f.items.filter((x) => x.key !== item.key) }))}>×</button>
                </div>
              ))}
            </div>
            <button type="button" className="link" onClick={() => setForm((f) => ({ ...f, items: [...f.items, emptyItem()] }))}>+ Add product</button>
          </div>
          <label className="field">Delivery charge (৳)<input value={form.deliveryCharge} onChange={set('deliveryCharge')} type="number" min="0" step="1" /></label>
          <label className="field">Discount (৳)<input value={form.discount} onChange={set('discount')} type="number" min="0" step="1" /></label>
          <label className="field">Advance paid (৳)<input value={form.advancePaid} onChange={set('advancePaid')} type="number" min="0" step="1" /></label>
          <label className="field">Note<input value={form.note} onChange={set('note')} placeholder="e.g. call before delivery" /></label>
          <div className="wide totals">
            {totals.map(([label, value, cls]) => <div key={label} className={`row ${cls ?? ''}`}><span>{label}</span><span>{value}</span></div>)}
          </div>
          <label className="wide check"><input type="checkbox" checked={form.sendSummary} onChange={set('sendSummary')} /> Send the order summary to the customer</label>
          <ErrorText className="wide error">{error}</ErrorText>
          <div className="wide"><button type="submit" disabled={busy}>Confirm order</button></div>
        </form>
      )}
    </Modal>
  );
}
