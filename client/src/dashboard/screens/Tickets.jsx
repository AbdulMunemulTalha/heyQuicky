import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Avatar, Button, Checkbox, Chips, Empty, ErrorState, Kpi, Modal, Pill, Skeleton, Tabs, toast } from '../ui/kit.jsx';
import './tickets.css';

const TYPES = ['complaint', 'refund', 'exchange', 'damaged', 'late', 'other'];
const RESOLUTIONS = ['refunded', 'exchanged', 'replaced', 'resent', 'explained', 'other'];
const STATUS_TONE = { open: 'yellow', waiting: 'blue', solved: 'green' };
const TYPE_TONE = { complaint: 'red', refund: 'purple', exchange: 'blue', damaged: 'orange', late: 'yellow', other: 'gray' };
const tid = (t, n) => `T-${t.num(n)}`;

// How long a ticket has been open: "42 min", "3 h", "2 days".
function age(t, at) {
  const min = Math.max(1, Math.round((Date.now() - new Date(at)) / 60_000));
  if (min < 60) return t('tk.ageMin', { n: t.num(min) });
  if (min < 1440) return t('tk.ageHours', { n: t.num(Math.round(min / 60)) });
  const days = Math.round(min / 1440);
  return t(days === 1 ? 'tk.ageDay' : 'tk.ageDays', { n: t.num(days) });
}

// Phase 2 · Support tickets (TKT-01/02), frame "Support tickets": counters and a table on the
// left, the open ticket in a panel on the right.
export default function Tickets({ params, query }) {
  const t = useT();
  const { socket, openOverlay, can } = useDash();
  const status = ['open', 'waiting', 'solved', 'all'].includes(query.status) ? query.status : 'open';
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
  const avg = d?.kpis.avgSolveHours;
  return (
    <div className={`tickets${selected ? ' with-panel' : ''}`}>
      <div className="tk-main">
        <header className="page-head">
          <div><h1>{t('tk.title')}</h1><p className="page-sub">{t('tk.sub')}</p></div>
          <div className="page-actions">
            {can('reply') && <Button variant="primary" onClick={() => openOverlay('newTicket', { onDone: (n) => navigate(`/tickets/${n}`) })}>{t('tk.new')}</Button>}
          </div>
        </header>
        {d && (
          <div className="tk-kpis">
            <Kpi label={t('tk.kOpen')} value={t.num((d.counts.open ?? 0) + (d.counts.waiting ?? 0))} />
            <Kpi label={t('tk.kActNow')} value={t.num(d.counts.actNow)} tone={d.counts.actNow ? 'red' : undefined} />
            <Kpi label={t('tk.kAvg')} value={avg == null ? '—' : avg >= 24 ? t('tk.days', { n: t.num(Math.round(avg / 2.4) / 10) }) : t('tk.hours', { n: t.num(avg) })} />
            <Kpi label={t('tk.kSolved')} value={t.num(d.kpis.solved30)} tone="green" />
          </div>
        )}
        <div className="card card-flush tk-listcard">
          <div className="tk-filters">
            <Tabs label={t('tk.title')} value={mine ? 'mine' : status} onChange={(v) => setQuery({ status: v === 'open' || v === 'mine' ? null : v, mine: v === 'mine' ? '1' : null })}
              items={[{ key: 'open', label: t('tk.status.open'), count: (d?.counts.open ?? 0) + (d?.counts.waiting ?? 0) }, { key: 'mine', label: t('tk.mine'), count: d?.counts.mine },
                { key: 'solved', label: t('tk.status.solved'), count: d?.counts.solved }, { key: 'all', label: t('tk.all'), count: d?.counts.all }]} />
            <input className="input input-sm tk-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tk.search')} aria-label={t('tk.search')} />
          </div>
          {!d ? <div style={{ padding: 16 }}><Skeleton h={60} r={10} /></div> : d.tickets.length === 0 ? (
            <Empty icon="ticket" tone="green" title={t(`tk.empty.${status}`)}>{t('tk.emptySub')}</Empty>
          ) : (
            <div className="tk-tablewrap">
              <table className="tk-table">
                <thead><tr>
                  <th scope="col">{t('tk.colTicket')}</th><th scope="col">{t('tk.colCustomer')}</th><th scope="col">{t('tk.type')}</th>
                  <th scope="col">{t('tk.owner')}</th><th scope="col">{t('tk.colAge')}</th><th scope="col">{t('tk.statusLabel')}</th>
                </tr></thead>
                <tbody>
                  {d.tickets.map((x) => (
                    <tr key={x.id} className={`${selected === x.number ? 'on' : ''}`} onClick={() => navigate(`/tickets/${x.number}${window.location.search}`)}>
                      <td>
                        <button type="button" className="tk-open" onClick={(e) => { e.stopPropagation(); navigate(`/tickets/${x.number}${window.location.search}`); }}>
                          <span className="tk-titleline">{x.actNow && x.status !== 'solved' && <Pill className="pill-act">{t('ov.tag.actNow')}</Pill>}<strong className="bn-ok">{x.title}</strong></span>
                          <small className="muted">{tid(t, x.number)}{x.order?.number && ` · ${t('tk.orderLower', { n: x.order.number })}`}</small>
                        </button>
                      </td>
                      <td>{x.customer || <span className="muted">{t('tk.noCustomer')}</span>}</td>
                      <td><Pill tone={TYPE_TONE[x.type] ?? 'gray'}>{t(`tk.type.${x.type}`)}</Pill></td>
                      <td>{x.owner ? <span className="tk-owner"><Avatar name={x.owner.name} size={20} />{x.owner.name}</span> : <span className="muted">{t('tk.noOwner')}</span>}</td>
                      <td className={x.status === 'solved' ? 'muted' : x.overdue ? 'tk-over' : 'tk-age'}>{age(t, x.status === 'solved' && x.solvedAt ? x.at : x.at)}</td>
                      <td><Pill tone={STATUS_TONE[x.status]}>{t(`tk.status.${x.status}`)}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {selected && <Detail key={selected} t={t} n={selected} onChanged={load} />}
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
  const close = () => navigate(`/tickets${window.location.search}`);

  if (error) return <aside className="tk-panel"><ErrorState thing={t('tk.ticketN', { n })} error={error} onRetry={load} back={close} /></aside>;
  if (!d) return <aside className="tk-panel"><Skeleton h={300} r={12} /></aside>;
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
    <aside className="tk-panel" aria-label={t('tk.ticketN', { n })}>
      <div className="tk-phead">
        <div className="tk-pills">
          {x.actNow && x.status !== 'solved' && <Pill className="pill-act">{t('ov.tag.actNow')}</Pill>}
          {edit ? (
            <select className={`pill pill-${TYPE_TONE[x.type] ?? 'gray'} tk-typesel`} value={x.type} onChange={(e) => patch({ type: e.target.value })} aria-label={t('tk.type')}>
              {TYPES.map((k) => <option key={k} value={k}>{t(`tk.type.${k}`)}</option>)}
            </select>
          ) : <Pill tone={TYPE_TONE[x.type] ?? 'gray'}>{t(`tk.type.${x.type}`)}</Pill>}
          {x.overdue && <Pill tone="red">{t('tk.overdue')}</Pill>}
          <small className="muted">{tid(t, x.number)} · {t('tk.opened', { when: t.agoLong(x.at) })}</small>
        </div>
        <button type="button" className="tk-close" onClick={close} aria-label={t('common.close')}>×</button>
      </div>
      <h2 className="bn-ok">{x.title}</h2>
      <div className="tk-sub">
        <span className="small">
          {x.customer || t('tk.noCustomer')}{x.vip && ' · VIP'}
          {x.order?.number && <> · <button type="button" className="linklike" onClick={() => navigate(`/orders/${x.order.number}`)}>{t('inbox.orderN', { n: x.order.number })}</button></>}
        </span>
        {x.conversationId && <Button size="sm" onClick={() => navigate(`/inbox/${x.conversationId}`)}>{t('tk.openChat')}</Button>}
      </div>

      {x.why && (
        <div className="tk-why">
          <strong className="small">{t('tk.why')}</strong>
          <p className="small bn-ok">{x.why}</p>
        </div>
      )}
      {x.lastMessage && <div className="tk-last bn-ok">{x.lastMessage}</div>}

      <div className="tk-two">
        <label className="field"><span className="field-label">{t('tk.owner')}</span>
          <select className="input" value={x.owner?.id ?? ''} disabled={!edit} onChange={(e) => patch({ ownerId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t('tk.noOwner')}</option>
            {d.team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">{t('tk.statusLabel')}</span>
          <select className="input" value={x.status} disabled={!edit}
            onChange={(e) => (e.target.value === 'solved' ? setSolving(true) : patch({ status: e.target.value }, e.target.value === 'open' && x.status === 'solved' ? t('tk.reopened') : t('common.saved')))}>
            {['open', 'waiting', 'solved'].map((st) => <option key={st} value={st}>{t(`tk.statusOpt.${st}`)}</option>)}
          </select>
        </label>
      </div>
      {edit && x.status !== 'solved' && (
        <button type="button" className={`chip tk-actnow${x.actNow ? ' on' : ''}`} aria-pressed={x.actNow} onClick={() => patch({ actNow: !x.actNow })}>{t('tk.actNowChip')}</button>
      )}

      <section className="tk-sec">
        <h3>{t('tk.resolution')}</h3>
        {x.status === 'solved' ? (
          <p className="tk-resolution bn-ok"><strong>{t(`tk.res.${x.resolutionKind || 'other'}`)}</strong> — {x.resolution}</p>
        ) : edit ? (
          <div className="tk-chips">
            {x.resolutions.map((r) => (
              <button key={r} type="button" className="chip" onClick={() => patch({ status: 'solved', resolutionKind: r, resolution: t(`tk.res.${r}`) }, t('tk.solvedWith', { r: t(`tk.res.${r}`) }))}>{t(`tk.res.${r}`)}</button>
            ))}
            <button type="button" className="chip" onClick={() => setSolving(true)}>{t('tk.resOther')}</button>
          </div>
        ) : <p className="small muted">{t('tk.notSolved')}</p>}
      </section>

      <section className="tk-sec">
        <h3>{t('tk.timeline')}</h3>
        <ol className="tk-timeline">
          {x.timeline.map((e, i) => (
            <li key={i} className={`tl-${e.type}`}>
              <span className="tl-dot" aria-hidden="true" />
              <span className="bn-ok tl-text">{e.type === 'note' ? <><strong>{e.by}:</strong> {e.text}</> : e.text}</span>
              <time className="muted">{t.ago(e.at)}</time>
            </li>
          ))}
        </ol>
        {edit && (
          <form className="tk-note" onSubmit={addNote}>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('tk.notePlaceholder')} aria-label={t('tk.addNote')} maxLength={1000} />
            {note.trim() && <Button type="submit" size="sm" busy={busy}>{t('tk.addNote')}</Button>}
          </form>
        )}
      </section>

      {x.conversationId && (
        <details className="tk-sec tk-chatsec">
          <summary><h3>{t('tk.chat')}</h3></summary>
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
              <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!reply.trim()}>{t('tk.replyInChat')}</Button>
            </form>
          )}
        </details>
      )}
      {d.orders.length > 0 && (
        <section className="tk-sec">
          <h3>{t('tk.orders')}</h3>
          {d.orders.map((o) => (
            <button key={o.id} type="button" className="tk-order" onClick={() => navigate(`/orders/${o.number}`)}>
              <strong>#{t.num(o.number)}</strong><span className="muted small">{t.money(o.total)} · {o.status.replace(/_/g, ' ')} · {t.ago(o.at)}</span>
            </button>
          ))}
        </section>
      )}
      {solving && <SolveDialog t={t} onClose={() => setSolving(false)} onSolve={async (body) => { await patch({ status: 'solved', ...body }, t('tk.solved')); setSolving(false); }} />}
    </aside>
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
