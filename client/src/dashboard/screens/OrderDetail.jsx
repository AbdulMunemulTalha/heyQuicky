import { useCallback, useEffect, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Link, navigate } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Avatar, Button, Card, ErrorState, Modal, Pill, Skeleton, toast } from '../ui/kit.jsx';
import { STATUS_TONE, CancelDialog } from './Orders.jsx';
import './orders.css';

const STEPS = ['pending', 'approved', 'processing', 'ready_to_ship', 'in_transit', 'delivered'];
const NEXT_ACTION = { pending: 'approved', on_hold: 'approved', approved: 'processing', processing: 'ready_to_ship', in_transit: 'delivered' };

// Screen 11: one order — on hold with a change request (11), in transit with tracking (11b), cancel with a reason (11c).
export default function OrderDetail({ params }) {
  const t = useT();
  const { socket, can, me } = useDash();
  const [o, setO] = useState(null);
  const [error, setError] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => dash(`/orders/${params.n}`).then((d) => { setO(d); setError(null); }, setError), [params.n]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    const on = (e) => { if (!o || e.id === o.id) load(); };
    socket.on('order', on);
    return () => socket.off('order', on);
  }, [socket, load, o]);

  // Screen 24: order summary, delivery update or review request as a card in the customer's chat.
  async function sendCard(type) {
    try { await dash(`/orders/${o.id}/message`, { method: 'POST', body: { type } }); toast(t('od.msg.sent'), 'green'); load(); } catch (e) { toast(e.message, 'red'); }
  }

  async function post(path, body, ok) {
    setBusy(true);
    try {
      const r = await dash(path.startsWith('/') ? path : `/orders/${o.id}/${path}`, { method: 'POST', body });
      if (ok) toast(ok, 'green');
      await load();
      return r;
    } catch (err) { toast(err.message, 'red'); return null; } finally { setBusy(false); }
  }

  async function printLabel() {
    const win = window.open('', '_blank');
    const res = await fetch('/api/dash/orders/labels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ ids: [o.id] }) });
    win.document.write(await res.text());
    win.document.close();
  }

  if (error) return <ErrorState thing={t('od.thing')} error={error} onRetry={load} supportEmail={me.support.email} back={{ to: '/orders', label: t('state.backTo.orders') }} />;
  if (!o) return <div><Skeleton w={240} h={30} /><br /><Skeleton h={60} r={12} /><br /><Skeleton h={300} r={12} /></div>;

  const nextAction = NEXT_ACTION[o.status];
  const stepIndex = STEPS.indexOf(o.status === 'on_hold' ? 'pending' : o.status);
  const transit = o.status === 'in_transit' || o.status === 'delivered' || Boolean(o.tracking);

  return (
    <div className="od">
      <Link to="/orders" className="back-link">← {t('od.all')}</Link>
      <header className="page-head od-head">
        <div>
          <h1 className="row">{t('inbox.orderN', { n: t.digits(o.number) })}
            <Pill tone={STATUS_TONE[o.status]}>{t(`status.${o.status}`)}</Pill>
            {o.source === 'ai' && <Pill tone="blue">{t('od.takenByAi')}</Pill>}
            {o.draft && <Pill>{t('od.draft')}</Pill>}
          </h1>
          <p className="page-sub">{t('od.placed', { ago: t.agoLong(o.at), from: t(`od.src.${o.source}`) })}{o.status === 'on_hold' && o.holdReason && <> · {o.holdReason}</>}{o.status === 'cancelled' && o.cancelReason && <> · {t(`cancel.${o.cancelReason}`)}</>}</p>
        </div>
        <div className="page-actions">
          <Button onClick={printLabel}>{t('od.printLabel')}</Button>
          {o.billToken && <Button onClick={() => copyBill(`${window.location.origin}/b/${o.billToken}`)} title={t('od.billHint')}>{t('od.bill')}</Button>}
          {can('edit_orders') && ['pending', 'on_hold', 'approved', 'processing'].includes(o.status) && <Button onClick={() => navigate(`/orders/${o.number}/edit`)}>{t('od.edit')}</Button>}
          <span className="od-main-actions">
          {can('cancel_orders') && o.next.includes('cancelled') && <Button variant="danger" onClick={() => setCancelOpen(true)}>{t('ord.cancelOrder')}</Button>}
          {can('edit_orders') && nextAction && o.next.includes(nextAction) && (
            <Button variant="primary" busy={busy} onClick={() => (nextAction === 'delivered' ? post('deliver', {}, t('od.delivered')) : post(`/orders/${o.id}/status`, { status: nextAction }, t('ord.statusChanged', { n: o.number, status: t(`status.${nextAction}`) })))}>
              {t(`od.action.${nextAction}`)}
            </Button>
          )}
          </span>
        </div>
      </header>

      {o.status !== 'cancelled' && o.status !== 'returned' && (
        <ol className="od-steps" aria-label={t('od.progress')}>
          {STEPS.map((s, i) => (
            <li key={s} className={i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
              <span className="od-step-dot">{i < stepIndex ? <Icon name="check" size={12} /> : t.digits(i + 1)}</span>{t(`status.${s}`)}
            </li>
          ))}
        </ol>
      )}

      {o.cancelRequestedAt && ['pending', 'approved', 'on_hold', 'processing'].includes(o.status) && (
        <div className="alert-bar alert-red"><Icon name="alert" size={16} /><div className="grow"><strong>{t('od.cancelAsked', { ago: t.agoLong(o.cancelRequestedAt) })}</strong> {t('od.cancelAskedSub')}</div></div>
      )}

      {o.changeRequest && (
        <div className="alert-bar alert-yellow od-change">
          <Icon name="alert" size={16} />
          <div className="grow">
            <strong>{t('od.changeAsked', { field: t(`od.field.${o.changeRequest.field}`), ago: t.agoLong(o.changeRequest.at) })}</strong>
            <span><s>{o.changeRequest.old}</s> → <b>{o.changeRequest.new}</b>. {t('od.sameZone')}</span>
          </div>
          {can('edit_orders') && <>
            <Button size="sm" onClick={() => post('change', { action: 'keep' }, t('od.keptOld'))}>{t('od.keepOld')}</Button>
            <Button size="sm" variant="dark" onClick={() => post('change', { action: 'accept' }, t('od.accepted'))}>{t('od.acceptChange')}</Button>
          </>}
        </div>
      )}

      <div className="od-grid">
        <div className="od-col">
          <Card title={t('od.items')} action={<span className="small muted">{t('od.nProducts', { n: o.items.length })}</span>}>
            <ul className="od-items">
              {o.items.map((i, k) => (
                <li key={k}>
                  <span className="od-swatch" style={i.photo ? { backgroundImage: `url(${i.photo})` } : { background: i.colour }} />
                  <span className="grow">
                    <strong>{i.name}</strong>
                    <small className="muted">{[i.variant && t('od.size', { s: i.variant }), i.sku && `SKU ${i.sku}`].filter(Boolean).join(' · ')}</small>
                    {i.stock !== null && <Pill tone={i.stock > 0 ? 'green' : 'red'}>{i.stock > 0 ? t('od.inStock') : t('od.soldOut')}</Pill>}
                  </span>
                  <span className="muted small">{t.digits(i.qty)} × {t.money(i.price)}</span>
                  <strong className="num">{t.money(i.qty * i.price)}</strong>
                </li>
              ))}
            </ul>
            <dl className="od-totals">
              <div><dt>{t('od.subtotal')}</dt><dd>{t.money(o.subtotal)}</dd></div>
              <div><dt>{t('od.delivery', { zone: t(`zone.${o.zone}`) })}</dt><dd>{t.money(o.delivery)}</dd></div>
              <div><dt>{t('od.discount')}{o.coupon && ` · ${o.coupon}`}</dt><dd>{o.discount ? `−${t.money(o.discount)}` : t.money(0)}</dd></div>
              <div className="total"><dt>{t('od.total')}</dt><dd>{t.money(o.total)}</dd></div>
              <div><dt>{t('od.advancePaid')}</dt><dd>{t.money(o.advance)}</dd></div>
              <div className="strong"><dt>{t('od.toCollect')}</dt><dd>{t.money(o.cod)}</dd></div>
            </dl>
          </Card>

          <DeliveryCard t={t} o={o} transit={transit} can={can} busy={busy}
            onBook={(courier) => post('book', { courier }, t('ord.booked', { n: 1, courier: t(`courier.${courier}`) }))}
            onTrack={() => post('track', {}, t('od.trackingUpdated'))} />

          <Activity t={t} o={o} canNote={can('edit_orders')} onNote={(text) => post('notes', { text })} />
        </div>

        <div className="od-col">
          <Card>
            <div className="row">
              <Avatar name={o.customer.name} size={36} />
              <div className="grow"><strong>{o.customer.name}</strong><br /><small className="muted num">{t.digits(o.customer.phone)}</small></div>
            </div>
            <div className="od-two">
              <Button size="sm" disabled={!o.customer.conversationId} onClick={() => navigate(`/inbox/${o.customer.conversationId}`)}>{t('od.openChat')}</Button>
              <Button size="sm" disabled={!o.customer.rawPhone} onClick={() => { window.location.href = `tel:${o.customer.rawPhone}`; }}>{t('od.call')}</Button>
            </div>
            <div className="od-two od-stats">
              <div><small className="muted">{t('od.ordersWithYou')}</small><strong>{t.num(o.customer.orders)}</strong></div>
              <div><small className="muted">{t('od.spent')}</small><strong>{t.money(o.customer.spent)}</strong></div>
            </div>
            {o.check && (
              <div className={`od-check risk-${o.risk.level}`}>
                <div className="row"><strong>{t('od.courierCheck', { level: t(`risk.${o.risk.level}`) })}</strong><span className="grow" /><small>{t('od.allCouriers')}</small></div>
                <div className="meter"><span style={{ width: `${Math.round((o.check.rate ?? 0) * 100)}%` }} /></div>
                <small>{t('od.checkLine', { d: o.check.delivered, r: o.check.returned ?? o.check.total - o.check.delivered })}{o.risk.level !== 'low' && ` ${t(`od.riskAction.${o.risk.level}`)}`}</small>
                {o.check.sample && <small className="faint">{t('od.sampleData')}</small>}
              </div>
            )}
          </Card>

          <Card title={t('od.address')} action={can('edit_orders') && <Button size="sm" onClick={() => navigate(`/orders/${o.number}/edit`)}>{t('common.edit')}</Button>}>
            <p className="small">{o.address.full}</p>
            <div className="chips od-chips">
              <Pill>{t(`zone.${o.zone}`)}</Pill>
              {(o.address.district || o.address.thana) && <Pill>{[o.address.district, o.address.thana].filter(Boolean).join(' · ')}</Pill>}
              {o.zoneDays && <Pill>{o.zoneDays}</Pill>}
            </div>
          </Card>

          <Card title={t('od.payment')}>
            <dl className="od-totals">
              <div><dt>{t('od.method')}</dt><dd>{o.paid ? t('ord.paid') : o.advance ? t('ord.advance', { a: t.money(o.advance) }) : t('od.cod')}</dd></div>
              <div><dt>{t('od.paymentStatus')}</dt><dd>{o.paid ? <Pill tone="green">{t('ord.paid')}</Pill> : o.status === 'delivered' ? <Pill tone="green">{t('od.collected')}</Pill> : <Pill tone={o.advance ? 'blue' : 'yellow'}>{o.advance ? t('od.advanceIn') : t('od.notPaid')}</Pill>}</dd></div>
            </dl>
            {!o.paid && !o.advance && ['pending', 'on_hold', 'approved'].includes(o.status) && can('edit_orders') && (
              <>
                <Button variant="yellow" className="btn-block" onClick={() => setAdvanceOpen(true)}>{t('od.askAdvance', { a: t.money(o.advanceInfo?.requested ?? 300) })}</Button>
                <p className="small muted" style={{ marginTop: 6 }}>{o.advanceInfo?.requested ? t('od.advanceAsked', { a: t.money(o.advanceInfo.requested) }) : t('od.advanceHint')}</p>
              </>
            )}
            {o.advanceInfo?.trx_id && <p className="small muted">TrxID {o.advanceInfo.trx_id}</p>}
          </Card>

          {(o.chat.length > 0 || o.hasChat) && (
            <Card title={t('od.fromChat')} action={<Link to={`/inbox/${o.customer.conversationId}`} className="small">{t('common.viewAll')}</Link>}>
              {o.chat.length > 0 && (
                <ol className="msgs od-chat">
                  {o.chat.map((m, i) => <li key={i} className={`msg ${m.direction}${m.byAi ? ' ai' : ''}`}><div className="bubble bn-ok">{m.text}</div></li>)}
                </ol>
              )}
              {o.review && <p className="small">⭐ {t('od.rated', { n: t.num(o.review.rating) })}</p>}
              {o.hasChat && can('reply') && (
                <div className="od-send">
                  <span className="small muted">{t('od.sendToChat')}</span>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <Button size="sm" onClick={() => sendCard('summary')}>{t('od.msg.summary')}</Button>
                    {['ready_to_ship', 'in_transit', 'delivered', 'returned'].includes(o.status) && <Button size="sm" onClick={() => sendCard('update')}>{t('od.msg.update')}</Button>}
                    {o.status === 'delivered' && !o.review && <Button size="sm" onClick={() => sendCard('review')}>{t('od.msg.review')}</Button>}
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {cancelOpen && <CancelDialog t={t} order={o} onClose={() => setCancelOpen(false)}
        onCancel={async (reason, restock) => { await post(`/orders/${o.id}/status`, { status: 'cancelled', reason, restock }, t('od.cancelled')); setCancelOpen(false); }} />}
      {advanceOpen && <AdvanceDialog t={t} o={o} onClose={() => setAdvanceOpen(false)}
        onSend={async (amount) => { const r = await post('advance-request', { amount }); if (r) toast(r.sent ? t('od.advanceSent') : t('od.advanceNoChat'), r.sent ? 'green' : 'dark'); setAdvanceOpen(false); }} />}
    </div>
  );
}

function DeliveryCard({ t, o, transit, can, busy, onBook, onTrack }) {
  if (transit && o.tracking) {
    const done = { booked: 1, pending: 1, picked: 2, in_transit: 3, hub: 3, out_for_delivery: 4, delivered: 5 };
    const level = o.status === 'delivered' ? 5 : Math.max(done[o.tracking.status] ?? 1, 1);
    const steps = [['booked', t('od.tr.booked', { courier: t(`courier.${o.tracking.courier}`) })], ['picked', t('od.tr.picked')], ['hub', t('od.tr.hub')], ['out', t('od.tr.out')], ['delivered', t('od.tr.delivered')]];
    return (
      <Card title={t('od.deliveryTitle')} action={<span className="small muted">{t(`courier.${o.tracking.courier}`)} · {o.tracking.id} · <button type="button" className="btn btn-link small" onClick={onTrack} disabled={busy}>{t('od.refresh')}</button></span>}>
        <ol className="od-track">
          {steps.map(([key, label], i) => (
            <li key={key} className={i + 1 < level ? 'done' : i + 1 === level ? 'now' : ''}>
              <span className="od-track-dot" />
              <div className="grow"><strong>{label}</strong>
                {i === 0 && <small className="muted">{t('od.tr.consignment', { id: o.tracking.id })}</small>}
                {i === 4 && <small className="muted">{o.status === 'delivered' ? t('od.tr.paidOut', { a: t.money(o.cod), courier: t(`courier.${o.tracking.courier}`) }) : t('od.tr.expected', { days: o.zoneDays })}</small>}
              </div>
              {i === 0 && <time className="small faint">{t.time(o.tracking.at)}</time>}
            </li>
          ))}
        </ol>
      </Card>
    );
  }
  const bookable = ['approved', 'processing', 'ready_to_ship'].includes(o.status);
  return (
    <Card title={t('od.deliveryTitle')}>
      <p className="small muted">{bookable ? t('od.bookHint') : t('od.approveFirst')}</p>
      {o.couriers.length ? (
        <div className="od-couriers">
          {o.couriers.map((c) => (
            <button key={c.key} type="button" className="od-courier" disabled={!bookable || !can('book_couriers') || busy} onClick={() => onBook(c.key)}>
              <strong>{t(`courier.${c.key}`)}</strong>
              <small className="muted">{c.autoBook ? t('od.autoBook') : t('od.oneClick')}</small>
              <small className="ok-text">{c.rate === null ? t('od.noRate') : t('od.rate', { n: c.rate, district: o.address.district || '' })}</small>
            </button>
          ))}
        </div>
      ) : <p className="small">{t('od.noCouriers')} <Link to="/settings/courier">{t('settingsNav.courier')}</Link></p>}
    </Card>
  );
}

function Activity({ t, o, canNote, onNote }) {
  const [text, setText] = useState('');
  const label = (e) => e.text || (e.type === 'status' ? t('od.ev.status', { from: e.from ? t(`status.${e.from}`) : '—', to: t(`status.${e.to}`) }) : e.type);
  return (
    <Card title={t('od.activity')}>
      <ul className="od-activity">
        {o.events.map((e) => (
          <li key={e.id}>
            <Avatar name={e.who || (e.by === 'ai' ? 'AI' : 'System')} size={24} tone={e.by === 'ai' ? 'sky' : e.type === 'note' ? 'sand' : undefined} />
            <span className="grow">{e.type === 'note' && e.who && <strong>{e.who}: </strong>}{label(e)}</span>
            <time className="small faint">{t.ago(e.at)}</time>
          </li>
        ))}
      </ul>
      {canNote && (
        <form className="od-note" onSubmit={async (ev) => { ev.preventDefault(); if (!text.trim()) return; await onNote(text); setText(''); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('od.notePlaceholder')} aria-label={t('od.notePlaceholder')} />
          <Button type="submit" disabled={!text.trim()}>{t('od.addNote')}</Button>
        </form>
      )}
    </Card>
  );
}

function AdvanceDialog({ t, o, onClose, onSend }) {
  const [amount, setAmount] = useState(String(o.advanceInfo?.requested ?? 300));
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('od.advanceTitle')} subtitle={t('od.advanceSub', { bkash: o.bkash || '—' })} onClose={onClose} width={400}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} onClick={async () => { setBusy(true); await onSend(Number(amount)); setBusy(false); }}>{t('od.sendRequest')}</Button></>}>
      <div className="field"><label htmlFor="adv">{t('od.advanceAmount')}</label><input id="adv" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} /></div>
    </Modal>
  );
}

// "Customer's bill": copies the link to share in chat and opens it to check what the customer sees.
function copyBill(url) {
  navigator.clipboard?.writeText(url).catch(() => {});
  window.open(url, '_blank', 'noopener');
}
