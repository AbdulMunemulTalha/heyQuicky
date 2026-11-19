import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Card, Checkbox, Chips, Empty, ErrorState, Modal, Pill, Skeleton, Tabs, toast } from '../ui/kit.jsx';
import './tickets.css';

const STATUSES = ['open', 'waiting', 'solved'];
const TYPES = ['complaint', 'refund', 'exchange', 'damaged', 'late', 'other'];
const RESOLUTIONS = ['refunded', 'exchanged', 'replaced', 'resent', 'explained', 'other'];
const STATUS_TONE = { open: 'yellow', waiting: 'blue', solved: 'green' };

// Time left before a ticket is overdue: "due in 23 h" / "due in 40 min".
function dueLeft(t, due) {
  const min = Math.max(1, Math.round((new Date(due) - Date.now()) / 60_000));
  return min >= 60 ? t('tk.dueHours', { n: t.num(Math.round(min / 60)) }) : t('tk.dueMin', { n: t.num(min) });
}

// Phase 2 · Support tickets (TKT-01/02): ACT NOW first, owner, status, resolution, timeline.
export default function Tickets({ params, query }) {
  const t = useT();
  const { socket, openOverlay, can } = useDash();
  const status = [...STATUSES, 'all'].includes(query.status) ? query.status : 'open';
  const mine = query.mine === '1';
  const [q, setQ] = useState(query.q ?? '');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ status, ...(mine ? { mine: '1' } : {}), ...(query.q ? { q: query.q } : {}) });
    return dash(`/tickets?${qs}`).then(setD, setError);
  }, [status, mine, query.q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('ticket', load);
    return () => socket.off('ticket', load);
  }, [socket, load]);
  useEffect(() => {
    const timer = setTimeout(() => { if ((query.q ?? '') !== q) setQuery({ q: q || null }); }, 350);
    return () => clearTimeout(timer);
  }, [q, query.q]);

  if (error) return <ErrorState thing={t('tk.title')} error={error} onRetry={load} />;
  const selected = params.n ? Number(params.n) : null;
  return (
    <div className="tickets">
      <header className="page-head">
        <div><h1>{t('tk.title')}</h1><p className="page-sub">{t('tk.sub')}</p></div>
        <div className="page-actions">
          {d?.counts.actNow > 0 && <Pill className="pill-act">{t('tk.actNowCount', { n: t.num(d.counts.actNow) })}</Pill>}
          {can('reply') && <Button variant="dark" onClick={() => openOverlay('newTicket', { onDone: (n) => navigate(`/tickets/${n}`) })}>{t('tk.new')}</Button>}
        </div>
      </header>
      <div className="tk-layout">
        <Card pad={false} className="tk-listcard">
          <div className="tk-filters">
            <Tabs label={t('tk.title')} value={status} onChange={(v) => setQuery({ status: v === 'open' ? null : v })}
              items={STATUSES.map((s) => ({ key: s, label: t(`tk.status.${s}`), count: d?.counts[s] }))} />
            <div className="row" style={{ gap: 8 }}>
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tk.search')} aria-label={t('tk.search')} />
              <button type="button" className={`chip${mine ? ' on' : ''}`} aria-pressed={mine} onClick={() => setQuery({ mine: mine ? null : '1' })}>{t('tk.mine')}</button>
            </div>
          </div>
          {!d ? <div style={{ padding: 16 }}><Skeleton h={60} r={10} /></div> : d.tickets.length === 0 ? (
            <Empty icon="ticket" tone="green" title={t(`tk.empty.${status}`)}>{t('tk.emptySub')}</Empty>
          ) : (
            <ul className="tk-list">
              {d.tickets.map((x) => (
                <li key={x.id}>
                  <button type="button" className={`tk-row${selected === x.number ? ' on' : ''}${x.actNow ? ' act' : ''}`} onClick={() => navigate(`/tickets/${x.number}${window.location.search}`)}>
                    <div className="row" style={{ gap: 6 }}>
                      <strong className="small">#{t.num(x.number)}</strong>
                      {x.actNow && <Pill className="pill-act">{t('ov.tag.actNow')}</Pill>}
                      <Pill tone="gray">{t(`tk.type.${x.type}`)}</Pill>
                      <span className="grow" />
                      <span className={`small ${x.overdue ? 'tk-over' : 'faint'}`}>{x.status === 'solved' ? t.ago(x.solvedAt) : x.overdue ? t('tk.overdue') : dueLeft(t, x.due)}</span>
                    </div>
                    <span className="tk-title bn-ok">{x.title}</span>
                    <small className="muted">{x.customer || t('tk.noCustomer')}{x.order?.number && ` · ${t('inbox.orderN', { n: x.order.number })}`} · {x.owner ? x.owner.name : t('tk.noOwner')}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected ? <Detail key={selected} t={t} n={selected} onChanged={load} /> : (
          <Card className="tk-detail tk-none"><Empty icon="ticket" title={t('tk.pick')}>{t('tk.pickSub')}</Empty></Card>
        )}
      </div>
    </div>
  );
}

function Detail({ t, n, onChanged }) {
  const { socket, can } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const [solving, setSolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dash(`/tickets/${n}`).then(setD, setError), [n]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    const on = (p) => { if (!p?.number || p.number === n) load(); };
    socket.on('ticket', on);
    return () => socket.off('ticket', on);
  }, [socket, load, n]);

  if (error) return <Card className="tk-detail"><ErrorState thing={t('tk.ticketN', { n })} error={error} onRetry={load} back={() => navigate('/tickets')} /></Card>;
  if (!d) return <Card className="tk-detail"><Skeleton h={300} r={12} /></Card>;
  const x = d.ticket;
  const edit = can('reply');
  async function patch(body, ok) {
    try { await dash(`/tickets/${n}`, { method: 'PATCH', body }); if (ok) toast(ok, 'green'); load(); onChanged(); } catch (err) { toast(err.message, 'red'); }
  }
  async function addNote(e) {
    e.preventDefault();
    setBusy(true);
    try { await dash(`/tickets/${n}/notes`, { method: 'POST', body: { text: note } }); setNote(''); load(); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function sendReply(e) {
    e.preventDefault();
    setBusy(true);
    try { await dash(`/tickets/${n}/reply`, { method: 'POST', body: { text: reply } }); setReply(''); toast(t('tk.replied'), 'green'); load(); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  return (
    <div className="tk-detail">
      <Card>
        <div className="tk-head">
          <div className="grow">
            <div className="row" style={{ gap: 6 }}>
              <strong>#{t.num(x.number)}</strong>
              <Pill tone={STATUS_TONE[x.status]}>{t(`tk.status.${x.status}`)}</Pill>
              {x.actNow && <Pill className="pill-act">{t('ov.tag.actNow')}</Pill>}
              {x.overdue && <Pill tone="red">{t('tk.overdue')}</Pill>}
            </div>
            <h2 className="bn-ok">{x.title}</h2>
            <small className="muted">{x.customer || t('tk.noCustomer')}{x.vip && ' · VIP'}{x.platform && ` · ${t(`ag.ch.${x.platform}`)}`} · {t('tk.opened', { when: t.agoLong(x.at) })}</small>
          </div>
          <div className="page-actions">
            {x.conversationId && <Button onClick={() => navigate(`/inbox/${x.conversationId}`)}>{t('tk.openChat')}</Button>}
            {x.order?.number && <Button onClick={() => navigate(`/orders/${x.order.number}`)}>{t('inbox.orderN', { n: x.order.number })}</Button>}
          </div>
        </div>

        <dl className="tk-facts">
          <div>
            <dt>{t('tk.owner')}</dt>
            <dd>
              <select className="input" value={x.owner?.id ?? ''} disabled={!edit} onChange={(e) => patch({ ownerId: e.target.value ? Number(e.target.value) : null })} aria-label={t('tk.owner')}>
                <option value="">{t('tk.noOwner')}</option>
                {d.team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </dd>
          </div>
          <div>
            <dt>{t('tk.type')}</dt>
            <dd>
              <select className="input" value={x.type} disabled={!edit} onChange={(e) => patch({ type: e.target.value })} aria-label={t('tk.type')}>
                {TYPES.map((k) => <option key={k} value={k}>{t(`tk.type.${k}`)}</option>)}
              </select>
            </dd>
          </div>
          <div>
            <dt>{t('tk.statusLabel')}</dt>
            <dd className="row" style={{ gap: 6 }}>
              {edit && x.status !== 'solved' && (
                <>
                  {x.status === 'open' ? <Button size="sm" onClick={() => patch({ status: 'waiting' }, t('tk.nowWaiting'))}>{t('tk.markWaiting')}</Button>
                    : <Button size="sm" onClick={() => patch({ status: 'open' })}>{t('tk.markOpen')}</Button>}
                  <Button size="sm" variant="primary" onClick={() => setSolving(true)}>{t('tk.solve')}</Button>
                </>
              )}
              {edit && x.status === 'solved' && <Button size="sm" onClick={() => patch({ status: 'open' }, t('tk.reopened'))}>{t('tk.reopen')}</Button>}
              {edit && x.status !== 'solved' && <button type="button" className={`chip${x.actNow ? ' on' : ''}`} aria-pressed={x.actNow} onClick={() => patch({ actNow: !x.actNow })}>{t('ov.tag.actNow')}</button>}
            </dd>
          </div>
        </dl>
        {x.status === 'solved' && (
          <div className="tk-resolution">
            <span className="small muted">{t('tk.resolution')}</span>
            <p className="bn-ok"><strong>{t(`tk.res.${x.resolutionKind || 'other'}`)}</strong> — {x.resolution}</p>
          </div>
        )}
      </Card>

      <div className="tk-cols">
        <Card title={t('tk.timeline')}>
          <ol className="tk-timeline">
            {x.timeline.map((e, i) => (
              <li key={i} className={`tl-${e.type}`}>
                <span className="tl-dot" aria-hidden="true" />
                <div>
                  <small className="muted">{t(`tk.tl.${e.type}`, {})} · {e.by || '—'} · {t.ago(e.at)}</small>
                  <p className="bn-ok">{e.text}</p>
                </div>
              </li>
            ))}
          </ol>
          {edit && (
            <form className="tk-note" onSubmit={addNote}>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('tk.notePlaceholder')} aria-label={t('tk.addNote')} maxLength={1000} />
              <Button type="submit" size="sm" busy={busy} disabled={!note.trim()}>{t('tk.addNote')}</Button>
            </form>
          )}
        </Card>
        <Card title={t('tk.chat')} pad={false}>
          {!x.conversationId ? <Empty icon="chat" title={t('tk.noChat')} /> : (
            <>
              <ol className="tk-chat">
                {d.chat.map((m) => (
                  <li key={m.id} className={`tk-msg ${m.direction === 'in' ? 'cust' : 'shop'}`}>
                    <div className="tk-bubble bn-ok">{m.text}</div>
                    <small className="faint">{m.direction === 'out' && (m.byAi ? 'AI · ' : '')}{t.time(m.at)}</small>
                  </li>
                ))}
              </ol>
              {edit && (
                <form className="tk-reply" onSubmit={sendReply}>
                  <textarea className="input" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('tk.replyPlaceholder')} aria-label={t('tk.replyInChat')} maxLength={2000} />
                  <Button type="submit" variant="primary" busy={busy} disabled={!reply.trim()}>{t('tk.replyInChat')}</Button>
                </form>
              )}
            </>
          )}
          {d.orders.length > 0 && (
            <div className="tk-orders">
              <span className="small muted">{t('tk.orders')}</span>
              {d.orders.map((o) => (
                <button key={o.id} type="button" className="tk-order" onClick={() => navigate(`/orders/${o.number}`)}>
                  <strong>#{t.num(o.number)}</strong><span className="muted small">{t.money(o.total)} · {o.status.replace(/_/g, ' ')} · {t.ago(o.at)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
      {solving && <SolveDialog t={t} onClose={() => setSolving(false)} onSolve={async (body) => { await patch({ status: 'solved', ...body }, t('tk.solved')); setSolving(false); }} />}
    </div>
  );
}

function SolveDialog({ t, onClose, onSolve }) {
  const [kind, setKind] = useState('explained');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('tk.solveTitle')} onClose={onClose} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!text.trim()} onClick={async () => { setBusy(true); await onSolve({ resolutionKind: kind, resolution: text }); setBusy(false); }}>{t('tk.solve')}</Button></>
    )}>
      <div className="tr-form">
        <Chips label={t('tk.resolution')} value={kind} onChange={setKind} items={RESOLUTIONS.map((k) => ({ key: k, label: t(`tk.res.${k}`) }))} />
        <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('tk.resolutionPlaceholder')} aria-label={t('tk.resolution')} maxLength={500} autoFocus />
      </div>
    </Modal>
  );
}

// "+ New ticket" — from the Tickets screen or a chat's header (overlay "newTicket").
export function NewTicket({ conversationId, title: startTitle = '', onDone, onClose }) {
  const t = useT();
  const [title, setTitle] = useState(startTitle);
  const [type, setType] = useState('complaint');
  const [orderNumber, setOrderNumber] = useState('');
  const [note, setNote] = useState('');
  const [actNow, setActNow] = useState(false);
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const r = await dash('/tickets', { method: 'POST', body: { title, type, note, actNow, conversationId: conversationId ?? null, orderNumber: orderNumber ? Number(orderNumber) : null } });
      toast(r.created ? t('tk.created', { n: r.number }) : t('tk.added', { n: r.number }), 'green');
      onClose();
      onDone?.(r.number);
      if (!onDone) navigate(`/tickets/${r.number}`);
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={t('tk.newTitle')} subtitle={conversationId ? t('tk.fromChat') : undefined} onClose={onClose} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!title.trim()} onClick={create}>{t('tk.create')}</Button></>
    )}>
      <div className="tr-form">
        <label className="small" htmlFor="tk-title"><strong>{t('tk.problem')}</strong></label>
        <input id="tk-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('tk.problemPlaceholder')} maxLength={160} autoFocus />
        <Chips label={t('tk.type')} value={type} onChange={setType} items={TYPES.map((k) => ({ key: k, label: t(`tk.type.${k}`) }))} />
        <input className="input" inputMode="numeric" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value.replace(/\D/g, ''))} placeholder={t('tk.orderOptional')} aria-label={t('tk.orderOptional')} />
        <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('tk.notePlaceholder')} aria-label={t('tk.addNote')} maxLength={300} />
        <Checkbox checked={actNow} onChange={setActNow} label={t('tk.markActNow')} />
      </div>
    </Modal>
  );
}
