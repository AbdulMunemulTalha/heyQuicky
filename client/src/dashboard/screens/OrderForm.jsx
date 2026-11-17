import { useEffect, useMemo, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Link, navigate } from '../lib/router.jsx';
import { DISTRICTS, DHAKA_THANAS, splitAddress } from '../lib/bd.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Card, Checkbox, ErrorState, Pill, Skeleton, toast } from '../ui/kit.jsx';
import './orders.css';

// Bangladeshi mobile check, same rules as the server (ORD-10): 11 digits, 013–019, Bangla digits allowed.
export function phoneIssue(t, value) {
  const digits = String(value ?? '').replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/\D/g, '').replace(/^880/, '0').replace(/^88(?=01)/, '');
  if (!digits) return null;
  if (digits.length !== 11) return t('of.phoneDigits', { n: digits.length });
  if (!/^01[3-9]/.test(digits)) return t('of.phonePrefix');
  return null;
}

const SOURCES = ['phone', 'messenger', 'instagram', 'whatsapp', 'walk_in', 'website'];

// Screen 12: new order (and edit, at /orders/:n/edit).
export default function OrderForm({ params, query }) {
  const t = useT();
  const { can } = useDash();
  const editing = Boolean(params.n);
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [c, setC] = useState({ phone: '', name: '', address: '', district: '', thana: '', area: '', zone: 'inside_dhaka' });
  const [items, setItems] = useState([]); // { productId, sku, qty, name, label, price, stock, colour, variants }
  const [pay, setPay] = useState({ method: 'cod', advance: '', trxId: '' });
  const [coupon, setCoupon] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [note, setNote] = useState('');
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [bookNow, setBookNow] = useState(false);
  const [source, setSource] = useState(query.conversation ? 'messenger' : 'phone');
  const [lookup, setLookup] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [orderId, setOrderId] = useState(null);

  useEffect(() => {
    dash('/orders/form').then(setForm, setLoadError);
    if (editing) {
      dash(`/orders/${params.n}`).then(async (o) => {
        setOrderId(o.id);
        setC({ phone: o.customer.rawPhone ?? '', name: o.customer.name, address: o.address.full, district: o.address.district ?? '', thana: o.address.thana ?? '', area: '', zone: o.zone });
        const products = await dash('/orders/products');
        setItems(o.items.filter((i) => i.productId).map((i) => {
          const p = products.find((x) => x.id === i.productId);
          return { productId: i.productId, sku: i.sku, qty: i.qty, name: i.name, price: i.price, colour: i.colour, variants: p?.variants ?? [] };
        }));
        setPay({ method: o.paid ? 'paid' : o.advance ? 'bkash_advance' : 'cod', advance: o.advance ? String(o.advance) : '', trxId: o.advanceInfo?.trx_id ?? '' });
        if (o.coupon) { setCoupon(o.coupon); setCouponInput(o.coupon); }
        setNote(o.note ?? '');
      }, setLoadError);
    }
  }, [editing, params.n]);

  // Live summary from the server whenever the order changes.
  useEffect(() => {
    if (!items.length) { setQuote(null); return undefined; }
    const timer = setTimeout(async () => {
      try {
        setQuote(await dash('/orders/quote', { method: 'POST', body: { items: items.map(({ productId, sku, qty }) => ({ productId, sku, qty })), zone: c.zone, coupon, payment: { ...pay, advance: Number(pay.advance) || 0 }, orderId } }));
        setQuoteError('');
      } catch (err) {
        setQuoteError(err.message);
        if (coupon && /coupon|expired|used up|needs an order|starts/i.test(err.message)) setCoupon('');
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [items, c.zone, coupon, pay, orderId]);

  const set = (k) => (e) => setC((x) => ({ ...x, [k]: e.target.value }));
  const phoneError = phoneIssue(t, c.phone);

  async function check() {
    if (phoneError || !c.phone) { setErrors((e) => ({ ...e, phone: phoneError || t('of.phoneRequired') })); return; }
    try {
      const r = await dash(`/orders/lookup?phone=${encodeURIComponent(c.phone)}`);
      setLookup(r);
      if (r.name && !c.name) setC((x) => ({ ...x, name: r.name }));
    } catch (err) { toast(err.message, 'red'); }
  }

  function onAddress(value) {
    const parts = splitAddress(value);
    setC((x) => ({ ...x, address: value, district: parts.district || x.district, thana: parts.thana || x.thana, zone: parts.zone || x.zone }));
  }

  function validate() {
    const e = {};
    if (!c.phone) e.phone = t('of.phoneRequired');
    else if (phoneError) e.phone = phoneError;
    if (!c.name.trim()) e.name = t('of.nameRequired');
    if (c.address.trim().length < 6) e.address = t('of.addressRequired');
    if (!items.length) e.items = t('of.itemsRequired');
    if (items.some((i) => i.variants.length && !i.sku)) e.items = t('of.pickSize');
    if (pay.method === 'bkash_advance' && !(Number(pay.advance) > 0)) e.advance = t('of.advanceRequired');
    setErrors(e);
    return !Object.keys(e).length;
  }

  async function save(draft) {
    if (!validate()) { toast(t('of.fixErrors'), 'red'); return; }
    setBusy(true);
    try {
      const body = {
        ...c, items: items.map(({ productId, sku, qty }) => ({ productId, sku, qty })), coupon, note, draft, sendConfirmation, bookNow,
        courier: form?.couriers[0], source, conversationId: query.conversation ? Number(query.conversation) : undefined,
        payment: { method: pay.method, advance: Number(pay.advance) || 0, trxId: pay.trxId },
      };
      const r = editing ? await dash(`/orders/${orderId}`, { method: 'PATCH', body }) : await dash('/orders', { method: 'POST', body });
      toast(draft ? t('of.draftSaved') : editing ? t('of.saved', { n: r.number }) : t('of.created', { n: r.number }), 'green');
      if (r.booked?.error) toast(r.booked.error, 'red');
      navigate(`/orders/${r.number}`);
    } catch (err) {
      toast(err.message, 'red');
    } finally { setBusy(false); }
  }

  if (loadError) return <ErrorState thing={t('of.thing')} error={loadError} />;
  if (!form) return <Skeleton h={400} r={12} />;
  if (!can('edit_orders')) return <ErrorState thing={t('of.thing')} error={{ status: 403, message: t('of.noAccess') }} />;

  return (
    <div className="of">
      <Link to="/orders" className="back-link">← {t('od.all')}</Link>
      <header className="page-head">
        <div><h1>{editing ? t('of.editTitle', { n: t.digits(params.n) }) : t('ov.newOrder')}</h1><p className="page-sub">{t('of.sub')}</p></div>
        <div className="page-actions">
          <Button onClick={() => navigate(editing ? `/orders/${params.n}` : '/orders')}>{t('of.discard')}</Button>
          {!editing && <Button onClick={() => save(true)} busy={busy}>{t('of.saveDraft')}</Button>}
        </div>
      </header>

      <div className="of-grid">
        <div className="od-col">
          <Card title={<><span className="of-num">1</span>{t('of.customer')}</>}>
            <div className="of-two">
              <div className={`field${errors.phone ? ' has-error' : ''}`}>
                <label htmlFor="of-phone">{t('of.phone')}</label>
                <div className="row">
                  <input id="of-phone" inputMode="tel" value={c.phone} onChange={(e) => { set('phone')(e); setLookup(null); setErrors((x) => ({ ...x, phone: '' })); }}
                    onBlur={() => c.phone && !phoneError && check()} placeholder="01XXX-XXXXXX" aria-invalid={Boolean(errors.phone || phoneError)} aria-describedby="of-phone-hint" />
                  <Button onClick={check}>{t('of.check')}</Button>
                </div>
                <p id="of-phone-hint" className={phoneError || errors.phone ? 'field-error' : 'field-hint ok-text'}>{phoneError || errors.phone || (c.phone ? t('of.validNumber') : t('of.phoneHint'))}</p>
              </div>
              <div className={`field${errors.name ? ' has-error' : ''}`}>
                <label htmlFor="of-name">{t('of.name')}</label>
                <input id="of-name" value={c.name} onChange={set('name')} autoComplete="off" />
                {errors.name && <p className="field-error">{errors.name}</p>}
              </div>
            </div>
            {lookup && (
              <div className={`of-lookup risk-${lookup.risk.level}`}>
                <div className="row">
                  <Pill tone={lookup.risk.level === 'low' ? 'green' : lookup.risk.level === 'medium' ? 'yellow' : 'red'}>{t(`of.risk.${lookup.risk.level}`)}</Pill>
                  {lookup.check && <span>{t('of.lookupLine', { pct: Math.round((lookup.check.rate ?? 0) * 100), d: lookup.check.delivered, couriers: lookup.check.couriers.join(', ') })}</span>}
                </div>
                <small>{lookup.known ? t('of.returning', { n: lookup.orders, ago: lookup.lastOrderAt ? t.agoLong(lookup.lastOrderAt) : '—' }) : t('of.newCustomer')}{lookup.risk.level !== 'low' && ` · ${lookup.risk.action}`}</small>
                {lookup.check?.sample && <small className="faint">{t('od.sampleData')}</small>}
              </div>
            )}
          </Card>

          <Card title={<><span className="of-num">2</span>{t('of.address')}</>} action={lookup?.lastAddress && <Button size="sm" onClick={() => setC((x) => ({ ...x, ...lookup.lastAddress, zone: lookup.lastAddress.zone ?? x.zone }))}>{t('of.useLast')}</Button>}>
            <div className={`field${errors.address ? ' has-error' : ''}`}>
              <label htmlFor="of-addr">{t('of.fullAddress')}</label>
              <input id="of-addr" value={c.address} onChange={(e) => onAddress(e.target.value)} placeholder="House 9, Road 2, Block C, Mirpur 10" />
              <p className={errors.address ? 'field-error' : 'field-hint'}>{errors.address || t('of.addressHint')}</p>
            </div>
            <div className="of-three">
              <div className="field"><label htmlFor="of-district">{t('of.district')}</label>
                <select id="of-district" value={c.district} onChange={set('district')}><option value="">—</option>{DISTRICTS.map((d) => <option key={d}>{d}</option>)}</select></div>
              <div className="field"><label htmlFor="of-thana">{t('of.thana')}</label>
                <input id="of-thana" list="of-thanas" value={c.thana} onChange={set('thana')} /><datalist id="of-thanas">{DHAKA_THANAS.map((x) => <option key={x} value={x} />)}</datalist></div>
              <div className="field"><label htmlFor="of-area">{t('of.area')}</label><input id="of-area" value={c.area} onChange={set('area')} placeholder={t('common.optional')} /></div>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <span className="label-like">{t('of.zone')}</span>
              <div className="of-zones" role="radiogroup" aria-label={t('of.zone')}>
                {form.zones.map((z) => (
                  <button key={z.key} type="button" role="radio" aria-checked={c.zone === z.key} className={`of-zone${c.zone === z.key ? ' on-z' : ''}`} onClick={() => setC((x) => ({ ...x, zone: z.key }))}>
                    <strong>{t(`zone.${z.key}`)}</strong><small>{t.money(z.charge)} · {z.days}</small>
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <Card title={<><span className="of-num">3</span>{t('of.products')}</>}>
            <ProductSearch t={t} onAdd={(p) => setItems((list) => {
              const sku = p.variants.length === 1 ? p.variants[0].sku : '';
              if (list.some((i) => i.productId === p.id && i.sku === sku && sku)) return list.map((i) => (i.productId === p.id && i.sku === sku ? { ...i, qty: i.qty + 1 } : i));
              return [...list, { productId: p.id, sku, qty: 1, name: p.name, price: p.price, colour: p.colour, variants: p.variants }];
            })} />
            {errors.items && <p className="field-error">{errors.items}</p>}
            <ul className="of-items">
              {items.map((i, k) => {
                const v = i.variants.find((x) => x.sku === i.sku);
                return (
                  <li key={`${i.productId}-${k}`}>
                    <span className="od-swatch" style={{ background: i.colour }} />
                    <span className="grow"><strong>{i.name}</strong>
                      <small className={v && v.stock !== null && v.stock <= 3 ? 'warn-text' : 'muted'}>{t.money(v?.price ?? i.price)} {t('of.each')}{v && v.stock !== null && ` · ${t('of.left', { n: v.stock })}`}</small></span>
                    {i.variants.length > 0 && (
                      <select className="input input-sm of-size" value={i.sku} aria-label={t('of.size')} onChange={(e) => setItems((list) => list.map((x, j) => (j === k ? { ...x, sku: e.target.value } : x)))}>
                        <option value="">{t('of.size')}</option>
                        {i.variants.map((x) => <option key={x.sku} value={x.sku} disabled={x.stock === 0}>{x.label}{x.stock === 0 ? ` (${t('od.soldOut')})` : ''}</option>)}
                      </select>
                    )}
                    <span className="stepper">
                      <button type="button" aria-label={t('of.less')} onClick={() => setItems((list) => list.map((x, j) => (j === k ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}>−</button>
                      <span className="num">{t.digits(i.qty)}</span>
                      <button type="button" aria-label={t('of.more')} onClick={() => setItems((list) => list.map((x, j) => (j === k ? { ...x, qty: Math.min(99, x.qty + 1) } : x)))}>+</button>
                    </span>
                    <strong className="num of-line">{t.money((v?.price ?? i.price) * i.qty)}</strong>
                    <button type="button" className="modal-x" aria-label={t('of.remove', { name: i.name })} onClick={() => setItems((list) => list.filter((_, j) => j !== k))}><Icon name="x" size={14} /></button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title={<><span className="of-num">4</span>{t('of.payment')}</>}>
            <div className="of-zones" role="radiogroup" aria-label={t('of.payment')}>
              {['cod', 'bkash_advance', 'paid'].map((m) => (
                <button key={m} type="button" role="radio" aria-checked={pay.method === m} className={`of-zone${pay.method === m ? ' on-z' : ''}`} onClick={() => setPay((p) => ({ ...p, method: m }))}>
                  <strong>{t(`of.pay.${m}`)}</strong><small>{t(`of.pay.${m}Sub`)}</small>
                </button>
              ))}
            </div>
            {pay.method === 'bkash_advance' && (
              <div className="of-two" style={{ marginTop: 12 }}>
                <div className={`field${errors.advance ? ' has-error' : ''}`}><label htmlFor="of-adv">{t('of.advanceAmount')}</label>
                  <input id="of-adv" inputMode="numeric" value={pay.advance} onChange={(e) => setPay((p) => ({ ...p, advance: e.target.value.replace(/\D/g, '') }))} placeholder="300" />
                  {errors.advance && <p className="field-error">{errors.advance}</p>}</div>
                <div className="field"><label htmlFor="of-trx">{t('of.trx')}</label>
                  <input id="of-trx" value={pay.trxId} onChange={(e) => setPay((p) => ({ ...p, trxId: e.target.value.toUpperCase() }))} placeholder="BKH8X2K9QP" />
                  <p className="field-hint">{form.bkash ? t('of.bkashTo', { n: form.bkash }) : t('of.noBkash')}</p></div>
              </div>
            )}
            <div className="of-two" style={{ marginTop: 12 }}>
              <div className="field"><label htmlFor="of-coupon">{t('of.coupon')}</label>
                <div className="row">
                  <input id="of-coupon" value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="EID10" />
                  <Button onClick={() => setCoupon(couponInput.trim())} disabled={!couponInput.trim()}>{t('of.apply')}</Button>
                </div>
                {coupon && quote?.coupon && <p className="field-hint ok-text">{t('of.couponOk', { code: quote.coupon, a: t.money(quote.discount) })}</p>}
              </div>
              <div className="field"><label htmlFor="of-note">{t('of.note')}</label><input id="of-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('of.notePlaceholder')} /></div>
            </div>
          </Card>
        </div>

        <aside className="of-summary">
          <Card title={t('of.summary')}>
            <dl className="od-totals">
              <div><dt>{t('of.items', { n: quote?.count ?? 0 })}</dt><dd>{t.money(quote?.subtotal ?? 0)}</dd></div>
              <div><dt>{t('od.delivery', { zone: t(`zone.${c.zone}`) })}</dt><dd>{t.money(quote?.delivery ?? form.zones.find((z) => z.key === c.zone)?.charge ?? 0)}</dd></div>
              <div><dt>{t('od.discount')}{quote?.coupon && ` · ${quote.coupon}`}</dt><dd>{quote?.discount ? `−${t.money(quote.discount)}` : t.money(0)}</dd></div>
              <div className="total"><dt>{t('od.total')}</dt><dd>{t.money(quote?.total ?? 0)}</dd></div>
              <div><dt>{t('of.advance')}</dt><dd>{t.money(quote?.advance ?? 0)}</dd></div>
              <div className="strong"><dt>{t('of.toCollect')}</dt><dd>{t.money(quote?.cod ?? 0)}</dd></div>
            </dl>
            {quoteError && <p className="error-text small" role="alert">{quoteError}</p>}
            <div className="of-opts">
              <Checkbox checked={sendConfirmation} onChange={setSendConfirmation} label={t('of.sendConfirmation')} disabled={!query.conversation} hint={query.conversation ? '' : t('of.noChat')} />
              {can('book_couriers') && form.couriers.length > 0 && <Checkbox checked={bookNow} onChange={setBookNow} label={t('of.bookNow', { courier: t(`courier.${form.couriers[0]}`) })} />}
              <div className="field"><label htmlFor="of-source">{t('of.source')}</label>
                <select id="of-source" value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{t(`of.src.${s}`)}</option>)}</select></div>
            </div>
            <Button variant="primary" size="lg" className="btn-block" busy={busy} onClick={() => save(false)}>
              {editing ? t('of.saveChanges') : t('of.create', { a: t.money(quote?.total ?? 0) })}
            </Button>
            <p className="small muted center" style={{ marginTop: 8 }}>{t('of.reserved')}</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function ProductSearch({ t, onAdd }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => dash(`/orders/products?q=${encodeURIComponent(q)}`).then(setResults).catch(() => setResults([])), 150);
    return () => clearTimeout(timer);
  }, [q, open]);
  useEffect(() => {
    const close = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const list = useMemo(() => results.slice(0, 8), [results]);
  return (
    <div className="of-search" ref={box}>
      <div className="ib-search" style={{ margin: 0 }}><Icon name="search" size={14} />
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={t('of.searchProducts')} aria-label={t('of.searchProducts')}
          onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); onAdd(list[0]); setQ(''); setOpen(false); } }} /></div>
      {open && list.length > 0 && (
        <ul className="slash of-results" role="listbox">
          {list.map((p) => (
            <li key={p.id}><button type="button" role="option" aria-selected="false" disabled={!p.inStock} onClick={() => { onAdd(p); setQ(''); setOpen(false); }}>
              <span className="od-swatch sm" style={{ background: p.colour }} /> <strong>{p.name}</strong> <span className="muted">{p.code} · {t.money(p.price)}{!p.inStock && ` · ${t('od.soldOut')}`}</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
