import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { taka } from '../format.js';

const MODES = [
  ['off', 'Off', 'The AI does nothing. Moderators answer every message.'],
  ['suggest', 'Suggest replies', 'The AI writes a draft for each new customer message. A moderator checks it, edits it if needed, and sends it.'],
  ['auto', 'Auto-reply', 'The AI answers customers itself, in Bangla, Banglish or English. Orders, complaints, payments and anything it is unsure about go to a moderator.'],
];

// Settings → AI chat agent: mode, what the AI knows about the shop, and the product list.
export function AiSettings({ me, setMe, open }) {
  const ws = me.workspace;
  const [notes, setNotes] = useState(ws.shopNotes);
  const [notesSaved, setNotesSaved] = useState(false);
  const [products, setProducts] = useState([]);

  const loadProducts = useCallback(() => api('/products').then(setProducts).catch(() => {}), []);
  useEffect(() => { if (open) { loadProducts(); setNotes(ws.shopNotes); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveWorkspace(body) {
    const workspace = await api('/workspace', { method: 'PATCH', body });
    setMe((m) => ({ ...m, workspace }));
  }

  async function setMode(aiMode) {
    try {
      await saveWorkspace({ aiMode });
    } catch (err) {
      alert(err.message);
    }
  }

  async function saveNotes(e) {
    e.preventDefault();
    try {
      await saveWorkspace({ shopNotes: notes });
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    } catch (err) {
      alert(err.message);
    }
  }

  async function addProduct(e) {
    e.preventDefault();
    const form = e.target;
    const body = Object.fromEntries(new FormData(form));
    try {
      await api('/products', { method: 'POST', body: { ...body, price: Number(body.price) } });
      form.reset();
      form.name.focus();
      loadProducts();
    } catch (err) {
      alert(err.message);
    }
  }

  async function update(p, body) {
    try {
      await api(`/products/${p.id}`, { method: 'PATCH', body });
      loadProducts();
    } catch (err) {
      alert(err.message);
    }
  }

  async function remove(p) {
    if (!window.confirm(`Delete ${p.name}?`)) return;
    await api(`/products/${p.id}`, { method: 'DELETE' });
    loadProducts();
  }

  return (
    <>
      <h2>AI chat agent</h2>
      {!me.ai.available && (
        <p className="notice">
          AI replies aren't switched on for this server yet. Add an <code>ANTHROPIC_API_KEY</code> to the server's
          environment to turn them on. You can set everything up below in the meantime.
        </p>
      )}
      <div className="ai-modes" role="radiogroup" aria-label="AI mode">
        {MODES.map(([value, label, help]) => (
          <label key={value} className={`ai-mode ${ws.aiMode === value ? 'selected' : ''}`}>
            <input type="radio" name="aiMode" value={value} checked={ws.aiMode === value} onChange={() => setMode(value)} />
            <span><strong>{label}</strong><span className="muted small">{help}</span></span>
          </label>
        ))}
      </div>

      <h3 className="ai-subhead">About your shop</h3>
      <p className="muted small">
        What the AI should know besides your products: exchange and return rules, delivery times, payment steps,
        opening hours, sizes. It only ever answers from this, your products, delivery charges and saved replies.
      </p>
      <form onSubmit={saveNotes} className="ai-notes">
        <textarea rows={5} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Exchange within 3 days if the size doesn't fit. Delivery takes 1-2 days in Dhaka, 3-5 days outside. Advance payment by bKash: 01700-000000 (Personal)." />
        <div><button>Save</button> {notesSaved && <span className="ok-text small">Saved</span>}</div>
      </form>

      <h3 className="ai-subhead">Products</h3>
      <p className="muted small">The AI quotes prices and stock only from this list. Mark products out of stock instead of deleting them.</p>
      <table className="table">
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.name}</strong>
                {p.variants && <div className="muted small">{p.variants}</div>}
                {p.description && <div className="muted small">{p.description}</div>}
              </td>
              <td className="num">{taka(p.price)}</td>
              <td>
                <label className="check small">
                  <input type="checkbox" checked={p.inStock} onChange={(e) => update(p, { inStock: e.target.checked })} /> In stock
                </label>
              </td>
              <td><button className="ghost" onClick={() => remove(p)}>Delete</button></td>
            </tr>
          ))}
          {!products.length && <tr><td className="muted">No products yet.</td></tr>}
        </tbody>
      </table>
      <form className="inline-form" onSubmit={addProduct}>
        <input name="name" placeholder="Product name, e.g. Red kurti" required maxLength={120} />
        <input name="price" type="number" min="0" step="1" placeholder="Price (৳)" required style={{ maxWidth: 120 }} />
        <input name="variants" placeholder="Sizes / colours, e.g. M, L, XL" maxLength={300} />
        <input name="description" placeholder="Short description (optional)" maxLength={1000} />
        <button>Add product</button>
      </form>
    </>
  );
}
