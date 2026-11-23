import { useCallback, useEffect, useMemo, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Empty, ErrorState, Modal, PageHead, Pill, Skeleton, Tabs, Toggle, toast } from '../ui/kit.jsx';
import './bookings.css';

// Phase 3 · Bookings & quotes (BKG-01..04), frames "Bookings calendar" and "Quotes".
const HOUR_PX = 56;
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const TONE = { pending: 'yellow', confirmed: 'green', arrived: 'gray', no_show: 'red', cancelled: 'gray' };
const QTONE = { waiting: 'yellow', sent: 'blue', accepted: 'green', declined: 'gray', expired: 'gray' };

export function clock(t, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function Bookings({ query }) {
  const t = useT();
  const { can } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [week, setWeek] = useState(query.week || '');
  const [sel, setSel] = useState(null);
  const [dialog, setDialog] = useState(null); // 'new' | 'settings' | { reschedule }
  const tab = query.tab === 'quotes' ? 'quotes' : 'calendar';
  const load = useCallback(() => dash(`/bookings${week ? `?week=${week}` : ''}`).then((x) => { setD(x); setSel((s) => (s ? x.bookings.find((b) => b.id === s.id) ?? null : null)); }, setError), [week]);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('bk.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={480} r={12} />;
  if (!d.modules.bookings && !d.modules.quotes) return <Empty icon="calendar" title={t('bk.off')} actions={<Button onClick={() => navigate('/settings/modules')}>{t('bk.openModules')}</Button>}>{t('bk.offHint')}</Empty>;
  const showTab = !d.modules.bookings ? 'quotes' : !d.modules.quotes ? 'calendar' : tab;
  const shift = (days) => { const base = new Date(`${d.week[0]}T12:00:00Z`); base.setUTCDate(base.getUTCDate() + days); setWeek(base.toISOString().slice(0, 10)); };
  const s = d.settings;
  return (
    <div className={`bookings${sel && showTab === 'calendar' ? ' with-panel' : ''}`}>
      <div className="bk-main">
        <PageHead title={t('bk.title')} sub={t('bk.sub')} actions={<>
          {can('edit_products') && d.modules.bookings && <Button onClick={() => setDialog('settings')}>{t('bk.settings')}</Button>}
          {d.modules.bookings && can('reply') && <Button variant="primary" onClick={() => setDialog('new')} disabled={!s.services.length}>+ {t('bk.add')}</Button>}
        </>} />
        {d.modules.bookings && d.modules.quotes && (
          <Tabs label={t('bk.title')} value={showTab} onChange={(k) => setQuery({ tab: k === 'quotes' ? 'quotes' : undefined })} items={[
            { key: 'calendar', label: t('bk.tabCalendar', { n: t.num(d.counts.week) }) },
            { key: 'quotes', label: t('bk.tabQuotes', { n: t.num(d.counts.quotesWaiting) }) },
          ]} />
        )}
        {showTab === 'quotes' ? <Quotes t={t} onChanged={load} /> : !s.services.length ? (
          <Empty icon="calendar" title={t('bk.noServices')} actions={can('edit_products') && <Button variant="primary" onClick={() => setDialog('settings')}>{t('bk.setUp')}</Button>}>{t('bk.noServicesHint')}</Empty>
        ) : (
          <>
            <div className="bk-bar">
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="bk-nav" onClick={() => shift(-7)} aria-label={t('bk.prevWeek')}>‹</button>
                <strong>{shortDate(d.week[0])} – {shortDate(d.week[6])}, {d.week[6].slice(0, 4)}</strong>
                <button type="button" className="bk-nav" onClick={() => shift(7)} aria-label={t('bk.nextWeek')}>›</button>
                <Button size="sm" onClick={() => setWeek('')}>{t('bk.today')}</Button>
              </div>
              <small className="muted">{t('bk.slotsLine', { m: s.slotMin, open: clock(t, s.open), close: clock(t, s.close) })}{s.closedDays.length ? ` · ${t('bk.closedOn', { days: s.closedDays.map((x) => t(`bk.day.${DAY_KEYS[x]}`)).join(', ') })}` : ''}</small>
            </div>
            <Week t={t} d={d} sel={sel} onPick={setSel} />
          </>
        )}
      </div>
      {sel && showTab === 'calendar' && <Panel t={t} b={sel} can={can} onClose={() => setSel(null)} onChanged={load} onReschedule={() => setDialog({ reschedule: sel })} />}
      {dialog === 'settings' && <SettingsDialog t={t} s={s} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}
      {dialog === 'new' && <BookDialog t={t} services={s.services} onClose={() => setDialog(null)} onDone={(b) => { setDialog(null); setWeek(b.date); setSel(b); load(); }} />}
      {dialog?.reschedule && <BookDialog t={t} services={s.services} moving={dialog.reschedule} onClose={() => setDialog(null)} onDone={(b) => { setDialog(null); setWeek(b.date); setSel(b); load(); }} />}
    </div>
  );
}

function Week({ t, d, sel, onPick }) {
  const s = d.settings;
  const open = toMin(s.open);
  const close = toMin(s.close);
  const hours = [];
  for (let m = Math.floor(open / 60) * 60; m < close; m += 60) hours.push(m);
  const height = ((close - open) / 60) * HOUR_PX;
  const byDay = useMemo(() => Object.fromEntries(d.week.map((date) => [date, d.bookings.filter((b) => b.date === date)])), [d]);
  return (
    <div className="bk-week card" role="grid" aria-label={t('bk.title')}>
      <div className="bk-head" role="row">
        <span />
        {d.week.map((date) => (
          <span key={date} role="columnheader" className={date === d.today ? 'today' : ''}>{t(`bk.day.${DAY_KEYS[dayOf(date)]}`)} {Number(date.slice(8))}</span>
        ))}
      </div>
      <div className="bk-body" style={{ height }}>
        <div className="bk-times">{hours.map((m) => <span key={m} style={{ top: ((m - open) / 60) * HOUR_PX }}>{clock(t, `${String(m / 60).padStart(2, '0')}:00`)}</span>)}</div>
        {d.week.map((date) => {
          const closed = s.closedDays.includes(dayOf(date));
          return (
            <div key={date} className={`bk-col${closed ? ' closed' : ''}${date === d.today ? ' today' : ''}`} role="gridcell">
              {hours.map((m) => <i key={m} className="bk-line" style={{ top: ((m - open) / 60) * HOUR_PX }} />)}
              {closed && <span className="bk-closed">{t('bk.closed')}</span>}
              {byDay[date].map((b) => {
                const top = ((toMin(b.time) - open) / 60) * HOUR_PX;
                const h = Math.max(26, ((toMin(b.endTime) - toMin(b.time)) / 60) * HOUR_PX - 3);
                return (
                  <button key={b.id} type="button" className={`bk-ev tone-${TONE[b.status]}${sel?.id === b.id ? ' on' : ''}`} style={{ top, height: h }} onClick={() => onPick(b)}
                    aria-label={`${clock(t, b.time)} ${b.service} · ${b.name} · ${t(`bk.st.${b.status}`)}`}>
                    <strong>{clock(t, b.time)}</strong><span>{b.service} · {b.name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Panel({ t, b, can, onClose, onChanged, onReschedule }) {
  const [busy, setBusy] = useState('');
  const upcoming = ['pending', 'confirmed'].includes(b.status);
  async function set(status, confirmText) {
    // eslint-disable-next-line no-alert
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(status);
    try { await dash(`/bookings/${b.id}/status`, { method: 'POST', body: { status } }); toast(t(`bk.done.${status}`), 'green'); onChanged(); } catch (err) { toast(err.message, 'red'); } finally { setBusy(''); }
  }
  const by = b.source === 'ai' ? t('bk.byAi', { where: b.platform ? t(`bk.plat.${b.platform}`) : t('bk.chat') }) : t('bk.byTeam');
  return (
    <aside className="bk-panel" aria-label={b.service}>
      <div className="row"><Pill tone={TONE[b.status]}>{t(`bk.st.${b.status}`)}</Pill><span className="grow" /><button type="button" className="bk-x" onClick={onClose} aria-label={t('common.close')}>×</button></div>
      <h2>{b.service}</h2>
      <p className="muted small">{t(`bk.day.${DAY_KEYS[dayOf(b.date)]}`)}, {shortDate(b.date)} · {clock(t, b.time)}–{clock(t, b.endTime)}</p>
      <div className="bk-who">
        <span className="bk-av" aria-hidden="true">{b.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
        <span className="grow"><strong>{b.name}</strong><small className="muted">{b.phone}</small></span>
        {b.conversationId && <Button size="sm" onClick={() => navigate(`/inbox/${b.conversationId}`)}>{t('bk.chatBtn')}</Button>}
      </div>
      <dl className="bk-facts">
        {b.price > 0 && <><dt>{t('bk.price')}</dt><dd>{t.money(b.price)}</dd></>}
        {b.advance && <><dt>{t('bk.advance')}</dt><dd>{t.money(b.advance.amount)}{b.advance.verified ? ' ✓' : ''}</dd></>}
        {b.advance && <><dt>{t('bk.trx')}</dt><dd className="mono">{b.advance.trx_id || t('bk.trxWaiting')}</dd></>}
        <dt>{t('bk.bookedBy')}</dt><dd>{by}</dd>
      </dl>
      <h3>{t('bk.reminders')}</h3>
      <ul className="bk-rem">
        <li className={b.confirmationSentAt ? 'ok' : ''}>{b.confirmationSentAt ? '✓' : '○'} {t('bk.remConfirm')}</li>
        <li className={b.reminderSentAt ? 'ok' : b.reminderFailed ? 'bad' : ''}>{b.reminderSentAt ? '✓' : b.reminderFailed ? '!' : '○'} {t('bk.remDay')}{b.reminderSentAt ? ` · ${t('bk.sentAt', { when: t.ago(b.reminderSentAt) })}` : b.reminderFailed ? ` · ${b.reminderFailed}` : ''}</li>
      </ul>
      {b.note && <><h3>{t('bk.note')}</h3><p className="small bn-ok">{b.note}</p></>}
      {can('reply') && (
        <div className="bk-actions">
          {b.status === 'pending' && <Button variant="primary" busy={busy === 'confirmed'} onClick={() => set('confirmed')}>{t('bk.advanceGot')}</Button>}
          {upcoming && <Button onClick={onReschedule}>{t('bk.reschedule')}</Button>}
          {upcoming && <Button className="bk-danger" busy={busy === 'cancelled'} onClick={() => set('cancelled', t('bk.cancelAsk'))}>{t('common.cancel')}</Button>}
          {b.status === 'confirmed' && <Button variant="primary" busy={busy === 'arrived'} onClick={() => set('arrived')}>{t('bk.arrived')}</Button>}
          {b.status === 'confirmed' && new Date(b.start) < new Date() && <Button busy={busy === 'no_show'} onClick={() => set('no_show')}>{t('bk.noShow')}</Button>}
        </div>
      )}
    </aside>
  );
}

function BookDialog({ t, services, moving = null, onClose, onDone }) {
  const [f, setF] = useState({ serviceId: moving?.serviceId ?? services[0]?.id ?? '', date: '', time: '', name: '', phone: '', note: '', trxId: '' });
  const [days, setDays] = useState([]);
  const [times, setTimes] = useState([]);
  const [busy, setBusy] = useState(false);
  const service = services.find((x) => x.id === f.serviceId);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => {
    if (!f.serviceId) return;
    dash(`/bookings/slots?serviceId=${encodeURIComponent(f.serviceId)}&date=${f.date}`).then((r) => { setDays(r.days); setTimes(r.times); }, () => {});
  }, [f.serviceId, f.date]);
  async function save() {
    setBusy(true);
    try {
      const b = moving
        ? await dash(`/bookings/${moving.id}/reschedule`, { method: 'POST', body: { date: f.date, time: f.time } })
        : await dash('/bookings', { method: 'POST', body: f });
      toast(t(moving ? 'bk.moved' : 'bk.booked'), 'green');
      onDone(b);
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  const ready = f.date && f.time && (moving || (f.name.trim() && f.phone.trim()));
  return (
    <Modal title={t(moving ? 'bk.rescheduleTitle' : 'bk.newTitle')} subtitle={moving ? `${moving.service} · ${moving.name}` : undefined} onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!ready} onClick={save}>{t(moving ? 'bk.move' : 'bk.book')}</Button></>}>
      {!moving && (
        <div className="field"><label htmlFor="bk-svc">{t('bk.service')}</label>
          <select id="bk-svc" value={f.serviceId} onChange={(e) => setF((x) => ({ ...x, serviceId: e.target.value, date: '', time: '' }))}>
            {services.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.minutes} {t('bk.min')}{x.price ? ` · ${t.money(x.price)}` : ''}</option>)}
          </select>
        </div>
      )}
      <div className="field"><span className="lbl">{t('bk.day')}</span>
        <div className="bk-days" role="radiogroup" aria-label={t('bk.day')}>
          {days.map((x) => (
            <button key={x.date} type="button" role="radio" aria-checked={f.date === x.date} className={`bk-daychip${f.date === x.date ? ' on' : ''}`} disabled={!x.free} onClick={() => setF((y) => ({ ...y, date: x.date, time: '' }))}>
              <small>{t(`bk.day.${DAY_KEYS[dayOf(x.date)]}`)}</small><strong>{Number(x.date.slice(8))}</strong><small>{x.closed ? t('bk.closed') : x.free ? t('bk.freeN', { n: x.free }) : t('bk.full')}</small>
            </button>
          ))}
        </div>
      </div>
      {f.date && (
        <div className="field"><span className="lbl">{t('bk.time')}</span>
          <div className="bk-times-pick" role="radiogroup" aria-label={t('bk.time')}>
            {times.length ? times.map((x) => <button key={x} type="button" role="radio" aria-checked={f.time === x} className={`bk-timechip${f.time === x ? ' on' : ''}`} onClick={() => setF((y) => ({ ...y, time: x }))}>{clock(t, x)}</button>)
              : <small className="muted">{t('bk.noTimes')}</small>}
          </div>
        </div>
      )}
      {!moving && (
        <>
          <div className="row" style={{ gap: 10 }}>
            <div className="field grow"><label htmlFor="bk-name">{t('bk.name')}</label><input id="bk-name" value={f.name} onChange={set('name')} maxLength={80} /></div>
            <div className="field grow"><label htmlFor="bk-phone">{t('bk.phone')}</label><input id="bk-phone" value={f.phone} onChange={set('phone')} inputMode="tel" placeholder="01XXXXXXXXX" /></div>
          </div>
          {service?.advance > 0 && <div className="field"><label htmlFor="bk-trx">{t('bk.trxIf', { n: t.money(service.advance) })}</label><input id="bk-trx" value={f.trxId} onChange={set('trxId')} maxLength={20} className="mono" /></div>}
          <div className="field"><label htmlFor="bk-note">{t('bk.note')}</label><textarea id="bk-note" rows={2} value={f.note} onChange={set('note')} maxLength={500} className="bn-ok" /></div>
        </>
      )}
    </Modal>
  );
}

function SettingsDialog({ t, s, onClose, onSaved }) {
  const [f, setF] = useState({ ...s, services: s.services.map((x) => ({ ...x })) });
  const [busy, setBusy] = useState(false);
  const svc = (i, k) => (e) => setF((x) => ({ ...x, services: x.services.map((y, j) => (j === i ? { ...y, [k]: e.target.value } : y)) }));
  async function save() {
    setBusy(true);
    try { await dash('/settings/bookings', { method: 'PUT', body: f }); toast(t('common.saved'), 'green'); onSaved(); } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={t('bk.settings')} subtitle={t('bk.settingsSub')} onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} onClick={save}>{t('common.save')}</Button></>}>
      <h3 className="bk-h">{t('bk.services')}</h3>
      <div className="bk-svcs">
        <div className="bk-svc head"><span>{t('bk.service')}</span><span>{t('bk.minutes')}</span><span>{t('bk.price')}</span><span>{t('bk.advance')}</span><span /></div>
        {f.services.map((x, i) => (
          <div key={x.id || i} className="bk-svc">
            <input value={x.name} onChange={svc(i, 'name')} placeholder={t('bk.svcPh')} aria-label={t('bk.service')} maxLength={60} />
            <input type="number" min={10} max={480} step={5} value={x.minutes} onChange={svc(i, 'minutes')} aria-label={t('bk.minutes')} />
            <input type="number" min={0} value={x.price} onChange={svc(i, 'price')} aria-label={t('bk.price')} />
            <input type="number" min={0} value={x.advance} onChange={svc(i, 'advance')} aria-label={t('bk.advance')} />
            <button type="button" className="bk-x" onClick={() => setF((y) => ({ ...y, services: y.services.filter((_, j) => j !== i) }))} aria-label={t('common.delete')}>×</button>
          </div>
        ))}
        <Button size="sm" onClick={() => setF((y) => ({ ...y, services: [...y.services, { id: '', name: '', minutes: 30, price: 0, advance: 0 }] }))}>+ {t('bk.addService')}</Button>
      </div>
      <h3 className="bk-h">{t('bk.hours')}</h3>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="field"><label htmlFor="bk-open">{t('bk.opens')}</label><input id="bk-open" type="time" value={f.open} onChange={(e) => setF((x) => ({ ...x, open: e.target.value }))} /></div>
        <div className="field"><label htmlFor="bk-close">{t('bk.closes')}</label><input id="bk-close" type="time" value={f.close} onChange={(e) => setF((x) => ({ ...x, close: e.target.value }))} /></div>
        <div className="field"><label htmlFor="bk-slot">{t('bk.slot')}</label>
          <select id="bk-slot" value={f.slotMin} onChange={(e) => setF((x) => ({ ...x, slotMin: Number(e.target.value) }))}>{[15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} {t('bk.min')}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="bk-cap">{t('bk.capacity')}</label><input id="bk-cap" type="number" min={1} max={20} value={f.capacity} onChange={(e) => setF((x) => ({ ...x, capacity: e.target.value }))} /></div>
      </div>
      <div className="field"><span className="lbl">{t('bk.closedDays')}</span>
        <div className="bk-days">{DAY_KEYS.map((k, i) => {
          const on = f.closedDays.includes(i);
          return <button key={k} type="button" aria-pressed={on} className={`bk-timechip${on ? ' on' : ''}`} onClick={() => setF((x) => ({ ...x, closedDays: on ? x.closedDays.filter((y) => y !== i) : [...x.closedDays, i] }))}>{t(`bk.day.${k}`)}</button>;
        })}</div>
      </div>
      <div className="row" style={{ gap: 10, marginTop: 10 }}><Toggle checked={f.reminder} onChange={(v) => setF((x) => ({ ...x, reminder: v }))} label={t('bk.reminderToggle')} /><span className="small">{t('bk.reminderToggle')}</span></div>
    </Modal>
  );
}

function Quotes({ t, onChanged }) {
  const { can } = useDash();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => dash('/quotes').then(setList, (err) => toast(err.message, 'red')), []);
  useEffect(() => { load(); }, [load]);
  if (!list) return <Skeleton h={240} r={12} />;
  return (
    <>
      {list.length ? (
        <div className="card bk-quotes">
          <table>
            <thead><tr><th>{t('qt.request')}</th><th>{t('qt.customer')}</th><th>{t('qt.details')}</th><th>{t('qt.quote')}</th><th>{t('qt.status')}</th><th aria-label={t('qt.action')} /></tr></thead>
            <tbody>{list.map((q) => (
              <tr key={q.id}>
                <td><strong>{q.title}</strong><small className="muted">Q-{q.number} · {t.ago(q.createdAt)}</small></td>
                <td>{q.name || '—'}</td>
                <td className="bk-details bn-ok">{q.details}</td>
                <td className="num">{q.price ? t.money(q.price) : '—'}</td>
                <td><Pill tone={QTONE[q.status]}>{t(`qt.st.${q.status}`)}</Pill></td>
                <td>{q.status === 'waiting' && can('reply') ? <Button size="sm" variant="primary" onClick={() => setOpen(q)}>{t('qt.send')}</Button> : <Button size="sm" onClick={() => setOpen(q)}>{t('qt.view')}</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty icon="tag" title={t('qt.none')}>{t('qt.noneHint')}</Empty>}
      <p className="small muted" style={{ marginTop: 10 }}>{t('qt.how')}</p>
      {open && <QuoteDialog t={t} q={open} canSend={can('reply')} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); onChanged(); }} />}
    </>
  );
}

function QuoteDialog({ t, q, canSend, onClose, onDone }) {
  const [f, setF] = useState({ price: q.price ?? '', advance: q.advance || '', validDays: 7 });
  const [busy, setBusy] = useState(false);
  const editable = canSend && ['waiting', 'sent', 'expired'].includes(q.status);
  async function send() {
    setBusy(true);
    try { await dash(`/quotes/${q.id}/send`, { method: 'POST', body: f }); toast(t('qt.sentToast'), 'green'); onDone(); } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={`Q-${q.number} · ${q.title}`} subtitle={q.name} onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>{t('common.close')}</Button>{editable && <Button variant="primary" busy={busy} disabled={!Number(f.price)} onClick={send}>{t(q.status === 'waiting' ? 'qt.send' : 'qt.resend')}</Button>}</>}>
      <h3 className="bk-h">{t('qt.details')}</h3>
      <p className="small bn-ok" style={{ whiteSpace: 'pre-wrap' }}>{q.details || '—'}</p>
      {q.photos?.length > 0 && <div className="bk-photos">{q.photos.map((p) => <a key={p} href={p} target="_blank" rel="noreferrer"><img src={p} alt="" /></a>)}</div>}
      {q.conversationId && <Button size="sm" onClick={() => navigate(`/inbox/${q.conversationId}`)}>{t('bk.chatBtn')}</Button>}
      {editable ? (
        <div className="row" style={{ gap: 10, marginTop: 12 }}>
          <div className="field grow"><label htmlFor="qt-price">{t('qt.price')}</label><input id="qt-price" type="number" min={1} value={f.price} onChange={(e) => setF((x) => ({ ...x, price: e.target.value }))} /></div>
          <div className="field grow"><label htmlFor="qt-adv">{t('qt.advance')}</label><input id="qt-adv" type="number" min={0} value={f.advance} onChange={(e) => setF((x) => ({ ...x, advance: e.target.value }))} /></div>
          <div className="field"><label htmlFor="qt-days">{t('qt.valid')}</label><input id="qt-days" type="number" min={1} max={30} value={f.validDays} onChange={(e) => setF((x) => ({ ...x, validDays: e.target.value }))} /></div>
        </div>
      ) : (
        <p className="small" style={{ marginTop: 12 }}>{q.price ? `${t('qt.price')}: ${t.money(q.price)}${q.advance ? ` · ${t('qt.advance')}: ${t.money(q.advance)}` : ''}` : ''} · <Pill tone={QTONE[q.status]}>{t(`qt.st.${q.status}`)}</Pill></p>
      )}
      {editable && <p className="small muted">{t('qt.sendHint')}</p>}
    </Modal>
  );
}
