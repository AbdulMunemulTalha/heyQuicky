import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { ErrorText } from '../common.jsx';
import { Actions, Soon, StepHead, useSubmit } from './parts.jsx';

// PARKED ONBOARDING STEPS
// These steps were part of the 10-step onboarding and were taken out (Nov 2026) to make
// sign-up shorter: onboarding is now channels -> business & delivery -> AI assistant -> go live.
// Nothing imports this file, so none of it ships. Everything they use still exists:
// products and CSV/Google Sheet import (/api/products, /api/products/import), bKash/Nagad numbers
// (PATCH /api/workspace), the team API (/api/team) and the practice chat (/api/ai/practice).
//
// To bring a step back:
//   1. Import it in Onboarding.jsx and add it to STEPS (and to the render switch there).
//   2. Its key ('products', 'payments', 'team' or 'test') is still a valid onboardingStep on the
//      server (ONBOARDING_STEPS in src/db.js), so no backend change is needed.
//   3. Remove that key from LEGACY_STEP in Onboarding.jsx.
// Each step receives { ws, me, data, save, go, back } like the live steps.

export const practiceKey = (wsId) => `quicky:practice:${wsId}`;

// ---------- Step 6: products ----------

export function ProductsStep({ data, go, back }) {
  const [method, setMethod] = useState('hand');
  const [message, setMessage] = useState('');
  const { busy, error, run, setError } = useSubmit();
  const products = data.products ?? [];
  const fileRef = useRef(null);

  function report({ added, skipped }) {
    const head = `Added ${added} product${added === 1 ? '' : 's'}.`;
    const tail = skipped.length
      ? ` Skipped ${skipped.length}: ${skipped.slice(0, 3).map((s) => `line ${s.line} (${s.reason})`).join(', ')}${skipped.length > 3 ? '…' : ''}`
      : '';
    setMessage(head + tail);
    data.reload();
  }

  const importSheet = (e) => {
    e.preventDefault();
    const sheetUrl = new FormData(e.target).get('sheetUrl');
    run(async () => { report(await api('/products/import', { method: 'POST', body: { sheetUrl } })); e.target.reset(); });
  };
  const importCsv = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) { setError('That file is too big (2 MB at most).'); return; }
    if (!/\.csv$/i.test(file.name)) { setError('Choose a .csv file. In Excel: File → Save As → CSV.'); return; }
    run(async () => { report(await api('/products/import', { method: 'POST', body: { csv: await file.text() } })); });
    e.target.value = '';
  };
  const addOne = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    run(async () => {
      await api('/products', { method: 'POST', body: { name: f.name, price: Number(f.price), variants: f.variants } });
      e.target.reset();
      e.target.name.focus();
      setMessage('');
      data.reload();
    });
  };
  async function remove(p) {
    await api(`/products/${p.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    data.reload();
  }

  const methods = [
    ['sheet', 'Google Sheet', 'Paste a link. We read the Name and Price columns.'],
    ['csv', 'CSV or Excel', 'Upload a .csv file (Excel: Save As → CSV).'],
    ['shop', 'WooCommerce / Shopify', 'Products, stock and orders stay in sync.', true],
    ['facebook', 'From my Facebook posts', 'The AI reads your posts and drafts the catalog for you to check.', true],
    ['hand', 'Add by hand', 'Start with your top 10 sellers.'],
  ];

  return (
    <>
      <StepHead title="Add your products">The AI only offers what's in your catalog, with real prices and stock. Bring them in any way you like.</StepHead>
      <div className="method-grid">
        {methods.map(([key, title, hint, soon]) => (
          <button type="button" key={key} disabled={soon} className={`method${method === key ? ' on' : ''}`} onClick={() => setMethod(key)}>
            <b>{title}</b><small>{hint}</small>{soon && <Soon />}
          </button>
        ))}
      </div>
      <div className="onb-card">
        {method === 'sheet' && (
          <form className="inline-form" onSubmit={importSheet}>
            <input name="sheetUrl" required placeholder="https://docs.google.com/spreadsheets/d/…" />
            <button type="submit" disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
            <small className="muted wide">In the sheet: Share → General access → "Anyone with the link" (Viewer). Columns: Name, Price, and optionally Options/Size, Description, Stock.</small>
          </form>
        )}
        {method === 'csv' && (
          <div className="inline-form">
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={importCsv} hidden />
            <button type="button" onClick={() => fileRef.current.click()} disabled={busy}>{busy ? 'Importing…' : 'Choose CSV file'}</button>
            <small className="muted">First row: Name, Price, and optionally Options/Size, Description, Stock. Up to 500 products at once.</small>
          </div>
        )}
        {method === 'hand' && (
          <form className="inline-form" onSubmit={addOne}>
            <input name="name" required maxLength={120} placeholder="Product name, e.g. Red kurti" />
            <input name="price" required type="number" min="0" step="1" placeholder="Price (৳)" style={{ maxWidth: 130 }} />
            <input name="variants" maxLength={300} placeholder="Options, e.g. M, L, XL" />
            <button type="submit" disabled={busy}>Add</button>
          </form>
        )}
        {message && <p className="ok-text small">{message}</p>}
        <ErrorText>{error}</ErrorText>
      </div>

      <div className="onb-card">
        <div className="card-title-row"><b>Your catalog</b><span className="muted">{products.length} product{products.length === 1 ? '' : 's'}</span></div>
        {products.length ? (
          <table className="table">
            <tbody>
              {products.slice(0, 50).map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="num">৳{p.price.toLocaleString('en-IN')}</td>
                  <td className="muted">{p.variants}</td>
                  <td className="muted">{p.inStock ? 'In stock' : 'Out of stock'}</td>
                  <td><button type="button" className="link" onClick={() => remove(p)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted empty">No products yet. Without them, the AI won't quote any prices.</p>}
        {products.length > 50 && <p className="muted small">Showing 50 of {products.length}. See them all in Settings.</p>}
      </div>
      <Actions onBack={back} onSkip={products.length ? null : () => go('payments')} disabled={!products.length} onNext={() => go('payments')} />
    </>
  );
}

// ---------- Step 7: courier & payments ----------

export function PaymentsStep({ ws, save, go, back }) {
  const [bkash, setBkash] = useState(ws.bkashNumber);
  const [nagad, setNagad] = useState(ws.nagadNumber);
  const { busy, error, run } = useSubmit();
  return (
    <>
      <StepHead title="Courier and payments">Add numbers for advance payments. You can skip this and do it later in Settings.</StepHead>
      <div className="grid2">
        {[['Steadfast', 'Book parcels automatically when an order is approved.'], ['Pathao', 'Book with your Pathao merchant account.']].map(([name, hint]) => (
          <div className="onb-card courier" key={name}>
            <div className="card-title-row"><b>{name}</b><Soon /></div>
            <small className="muted">{hint} Courier booking is on its way; we'll let you know when you can connect.</small>
          </div>
        ))}
      </div>
      <div className="onb-card">
        <b className="card-title">Advance payments</b>
        <div className="grid2">
          <label className="field">bKash number<input value={bkash} onChange={(e) => setBkash(e.target.value)} inputMode="tel" placeholder="01XXX-XXXXXX" /></label>
          <label className="field">Nagad number<input value={nagad} onChange={(e) => setNagad(e.target.value)} inputMode="tel" placeholder="Optional" /></label>
        </div>
        <small className="muted">The AI shares these only when a customer wants to pay in advance. When someone says they've paid, the chat goes to your team to check.</small>
      </div>
      <ErrorText>{error}</ErrorText>
      <Actions onBack={back} onSkip={() => go('team')} busy={busy}
        onNext={() => run(() => save({ bkashNumber: bkash, nagadNumber: nagad }, 'team'))} />
    </>
  );
}

// ---------- Step 8: team & alerts ----------

export function TeamStep({ data, go, back }) {
  const { busy, error, run } = useSubmit();
  const [passwords, setPasswords] = useState({});
  const moderators = (data.team ?? []).filter((m) => m.role === 'moderator' && m.isActive);

  const add = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    run(async () => {
      const { user, password } = await api('/team', { method: 'POST', body });
      setPasswords((p) => ({ ...p, [user.id]: password }));
      e.target.reset();
      data.reload();
    });
  };

  return (
    <>
      <StepHead title="Your team and alerts">Invite teammates for free. Each new customer goes to one on-duty moderator, and comes back to the same one.</StepHead>
      <div className="onb-split">
        <div className="onb-card">
          <div className="card-title-row"><b>Invite your team</b><span className="tag">Unlimited · free</span></div>
          <form className="inline-form" onSubmit={add}>
            <input name="name" required placeholder="Name" maxLength={80} />
            <input name="email" type="email" required placeholder="Email they'll log in with" />
            <button type="submit" disabled={busy}>Add</button>
          </form>
          <ErrorText>{error}</ErrorText>
          <ul className="onb-list">
            {moderators.map((m) => (
              <li key={m.id}><b>{m.name}</b> · {m.email}
                {passwords[m.id] && <span className="muted"> · password: <code>{passwords[m.id]}</code> (share it with them; shown once)</span>}</li>
            ))}
            {data.team && !moderators.length && <li className="muted">Running the shop alone? Skip this; you can add people later.</li>}
          </ul>
        </div>
        <aside className="onb-card side-panel">
          <b>When a person is needed</b>
          <div className="check-row"><span>Shown in your inbox with the reason</span><input type="checkbox" checked readOnly /></div>
          <div className="check-row soon-row"><span>Phone notifications</span><Soon /></div>
          <div className="check-row soon-row"><span>WhatsApp alert to your number</span><Soon /></div>
          <div className="check-row soon-row"><span>Daily summary by email</span><Soon /></div>
        </aside>
      </div>
      <Actions onBack={back} onSkip={moderators.length ? null : () => go('test')} onNext={() => go('test')} disabled={!moderators.length} />
    </>
  );
}

// ---------- Step 9: test it ----------

export const PROMPTS = [
  ['Ask the price', 'Apnader best seller tar dam koto?'],
  ['Ask the delivery charge', 'Dhakar baire delivery charge koto? Koydin lagbe?'],
  ['Place an order', 'Ami order korte chai. Nusrat Jahan, 01811223344, House 12 Road 5 Dhanmondi'],
  ['Complain', 'Amar parcel ta chera eseche, taka ferot chai'],
];
export const CHECKS = [
  ['price', 'Answered a price question', (a) => ['price', 'stock', 'product_info'].includes(a.intent)],
  ['delivery', 'Quoted the delivery charge', (a) => a.intent === 'delivery'],
  ['order', 'Took a test order', (a) => a.intent === 'order'],
  ['complaint', 'Handed a complaint to you', (a) => a.intent === 'complaint' && a.handoff],
];

export function TestStep({ ws, me, go, back }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [passed, setPassed] = useState(() => JSON.parse(localStorage.getItem(practiceKey(ws.id)) || '[]'));
  const endRef = useRef(null);
  const available = me.ai.available;

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  useEffect(() => { localStorage.setItem(practiceKey(ws.id), JSON.stringify(passed)); }, [passed, ws.id]);

  async function send(content) {
    const value = content.trim();
    if (!value || busy) return;
    const next = [...messages, { role: 'user', content: value }];
    setMessages(next);
    setText('');
    setBusy(true);
    setError('');
    try {
      const answer = await api('/ai/practice', { method: 'POST', body: { messages: next.filter((m) => m.role !== 'note').map(({ role, content: c }) => ({ role, content: c })) } });
      setMessages((m) => [...m,
        ...(answer.reply ? [{ role: 'assistant', content: answer.reply }] : []),
        ...(answer.handoff ? [{ role: 'note', content: `Handed to your team: ${answer.handoff_reason || 'needs a person'}` }] : [])]);
      const hits = CHECKS.filter(([, , test]) => test(answer)).map(([key]) => key);
      if (hits.length) setPassed((p) => [...new Set([...p, ...hits])]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <StepHead title="Test it like a customer">You're in practice mode: only you see these replies, and nothing goes to Meta. Try a few real situations before going live.</StepHead>
      {!available && (
        <p className="notice rounded">AI replies aren't switched on for this server yet (it needs an ANTHROPIC_API_KEY). You can finish setup now and test here later from Settings.</p>
      )}
      <div className="onb-split">
        <div className="onb-card chat-test">
          <div className="card-title-row"><b>Chat as a customer</b><span className="tag warn-tag">Practice mode · nothing is sent</span></div>
          <div className="test-msgs">
            {messages.map((m, i) => (
              m.role === 'note' ? <p key={i} className="test-note">{m.content}</p>
                : <p key={i} className={m.role === 'user' ? 'b-out' : 'b-in'}>{m.content}</p>
            ))}
            {busy && <p className="b-in typing">{ws.aiName || 'AI'} is typing…</p>}
            {!messages.length && <p className="muted empty">Write like a customer would, in Bangla, Banglish or English.</p>}
            <span ref={endRef} />
          </div>
          <div className="chips try">
            <span className="muted small">Try:</span>
            {PROMPTS.map(([label, sample]) => (
              <button key={label} type="button" className="chip small" disabled={!available || busy} onClick={() => send(sample)}>{label}</button>
            ))}
          </div>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type like a customer…" disabled={!available} maxLength={1000} />
            <button type="submit" disabled={!available || busy || !text.trim()}>Send</button>
            {messages.length > 0 && <button type="button" className="ghost" onClick={() => setMessages([])}>Start over</button>}
          </form>
          <ErrorText>{error}</ErrorText>
        </div>
        <aside className="onb-card side-panel">
          <div className="card-title-row"><b>Checks</b><span className="ok-text small">{passed.length} of {CHECKS.length} passed</span></div>
          {CHECKS.map(([key, label]) => (
            <div key={key} className={`check-item${passed.includes(key) ? ' ok' : ''}`}><span className="tick">{passed.includes(key) ? '✓' : ''}</span>{label}</div>
          ))}
          <small className="muted">Something wrong? Add it to "About your shop" or your products in Settings, and the AI uses it from the next reply.</small>
        </aside>
      </div>
      <Actions onBack={back} next={passed.length ? 'Everything works' : 'Continue'} onNext={() => go('live')} />
    </>
  );
}
