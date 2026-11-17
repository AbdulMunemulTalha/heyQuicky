import { useCallback, useEffect, useState } from 'react';
import { dash, downloadFile } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Avatar, Button, Card, Empty, ErrorState, Pill, Skeleton, toast } from '../ui/kit.jsx';
import { STATUS_TONE } from './Orders.jsx';
import './customers.css';

const FILTERS = ['all', 'repeat', 'vip', 'high_risk'];
const CH = { messenger: 'M', instagram: 'IG', whatsapp: 'W', web: 'W' };

// Screen 04: customers with their history across channels and their courier record (CRM-01/02).
export default function Customers({ params, query }) {
  const t = useT();
  const { me } = useDash();
  const filter = FILTERS.includes(query.filter) ? query.filter : 'all';
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const selected = params.id ? Number(params.id) : list?.items[0]?.id ?? null;

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ filter, page: query.page ?? '1', ...(q ? { q } : {}) });
      setList(await dash(`/customers?${qs}`));
      setError(null);
    } catch (err) { setError(err); }
  }, [filter, q, query.page]);
  useEffect(() => { const timer = setTimeout(load, q ? 250 : 0); return () => clearTimeout(timer); }, [load, q]);

  return (
    <div className="customers">
      <header className="page-head">
        <div><h1>{t('nav.customers')}</h1><p className="page-sub">{list ? t('cu.sub', { n: t.num(list.everyone) }) : ' '}</p></div>
        <div className="page-actions">
          <Button onClick={() => navigate('/customers/segments')}>{t('cu.segments')}</Button>
          <Button onClick={() => downloadFile(`/customers.csv?filter=${filter}`, 'heyquicky-customers.csv').catch((e) => toast(e.message, 'red'))}>{t('cu.export')}</Button>
        </div>
      </header>
      <div className="cu-grid">
        <section className="card card-flush cu-list">
          <div className="cu-tools">
            <div className="ib-search" style={{ margin: 0, flex: 1 }}><Icon name="search" size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cu.search')} aria-label={t('cu.search')} /></div>
            <div className="chips">
              {FILTERS.map((f) => <button key={f} type="button" className={`chip${filter === f ? ' on' : ''}`} onClick={() => setQuery({ filter: f === 'all' ? null : f, page: null })}>{t(`cu.f.${f}`)}</button>)}
            </div>
          </div>
          {error ? <ErrorState thing={t('nav.customers')} error={error} onRetry={load} supportEmail={me.support.email} /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('cu.col.customer')}</th><th>{t('nav.orders')}</th><th>{t('cu.col.spent')}</th><th>{t('cu.col.delivered')}</th><th>{t('cu.col.last')}</th><th>{t('inbox.tags')}</th></tr></thead>
                <tbody>
                  {!list ? Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={6}><Skeleton h={26} /></td></tr>)
                    : list.items.length === 0 ? <tr><td colSpan={6}><Empty icon="search" tone="gray" title={q ? t('ord.noMatch', { q }) : t('cu.empty')}>{q ? t('cu.noMatchSub') : t('cu.emptySub')}</Empty></td></tr>
                      : list.items.map((c) => (
                        <tr key={c.id} className={c.id === selected ? 'selected-row' : ''} onClick={() => navigate(`/customers/${c.id}${window.location.search}`)} style={{ cursor: 'pointer' }}>
                          <td><strong>{c.name}</strong><span className="sub num">{t.digits(c.phone)}</span></td>
                          <td className="num">{t.num(c.orders)}</td>
                          <td className="num">{t.money(c.spent)}</td>
                          <td>{c.delivered === null ? <Pill>{t('cu.new')}</Pill> : <Pill tone={c.delivered >= 80 ? 'green' : c.delivered >= 60 ? 'yellow' : 'red'}>{t.pct(c.delivered)}</Pill>}</td>
                          <td className="muted nowrap">{c.lastActive ? t.agoLong(c.lastActive) : '—'}</td>
                          <td className="muted small">{c.tags.slice(0, 3).join(' · ') || (c.risk === 'high' ? t('cu.highRisk') : '')}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
          {list && list.total > list.perPage && (
            <footer className="ord-pager">
              <span className="small muted">{t('ord.showing', { from: (list.page - 1) * list.perPage + 1, to: Math.min(list.page * list.perPage, list.total), total: list.total })}</span>
              <Button size="sm" disabled={list.page <= 1} onClick={() => setQuery({ page: list.page - 1 })}>{t('common.back')}</Button>
              <Button size="sm" disabled={list.page * list.perPage >= list.total} onClick={() => setQuery({ page: list.page + 1 })}>{t('ord.next')}</Button>
            </footer>
          )}
        </section>
        {selected ? <Profile key={selected} id={selected} t={t} onChanged={load} /> : <div />}
      </div>
    </div>
  );
}

function Profile({ id, t, onChanged }) {
  const { can } = useDash();
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => dash(`/customers/${id}`).then(setC, setError), [id]);
  useEffect(() => { load(); }, [load]);

  async function addNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    try { await dash(`/customers/${id}/notes`, { method: 'POST', body: { text: note } }); setNote(''); load(); } catch (err) { toast(err.message, 'red'); }
  }
  async function tag(remove, value) {
    // eslint-disable-next-line no-alert
    const v = value ?? window.prompt(t('inbox.tagPrompt'));
    if (!v) return;
    try { await dash(`/customers/${id}/tags`, { method: 'POST', body: { tag: v, remove } }); load(); onChanged(); } catch (err) { toast(err.message, 'red'); }
  }

  if (error) return <Card><ErrorState thing={t('cu.thing')} error={error} onRetry={load} /></Card>;
  if (!c) return <Card><Skeleton h={300} /></Card>;
  const safe = c.risk.level === 'low';
  return (
    <aside className="card cu-profile" aria-label={c.name}>
      <div className="row">
        <Avatar name={c.name} size={44} />
        <div className="grow"><h2>{c.name}</h2><p className="small muted num">{t.digits(c.phones[0] ?? '')}{c.area && ` · ${c.area}`}</p></div>
      </div>
      <div className="od-two">
        <Button disabled={!c.conversationId} onClick={() => navigate(`/inbox/${c.conversationId}`)}>{t('cu.message')}</Button>
        {can('edit_orders') && <Button onClick={() => navigate(`/orders/new${c.conversationId ? `?conversation=${c.conversationId}` : ''}`)}>{t('ov.newOrder')}</Button>}
      </div>

      <section className={`cu-ship risk-${c.risk.level}`}>
        <div className="row"><strong className="small">{t('cu.beforeShip')}</strong><span className="grow" /><Pill tone={safe ? 'green' : c.risk.level === 'medium' ? 'yellow' : 'red'}>{t(`cu.risk.${c.risk.level}`)}</Pill></div>
        <div className="cu-ship-nums">
          <div><strong>{t.digits(c.stats.delivered)} / {t.digits(c.stats.delivered + c.stats.returned)}</strong><small>{t('cu.deliveredWithYou')}</small></div>
          {c.check && <div><strong>{t.pct((c.check.rate ?? 0) * 100)}</strong><small>{t('cu.allCouriers', { d: c.check.delivered, n: c.check.total })}</small></div>}
        </div>
        <small>{safe ? t('cu.safeCod') : c.risk.action}</small>
        {c.check?.sample && <small className="faint">{t('od.sampleData')}</small>}
      </section>

      <section>
        <h3 className="cu-h">{t('cu.timeline')}</h3>
        {c.timeline.length ? (
          <ul className="cu-timeline">
            {c.timeline.map((e, i) => (
              <li key={i}>
                <span className={`cu-ch ch-${e.kind === 'message' ? e.platform : e.kind}`}>{e.kind === 'message' ? CH[e.platform] ?? 'M' : e.kind === 'order' ? '#' : 'C'}</span>
                <button type="button" className="grow" onClick={() => navigate(e.link)}>
                  <span className="bn-ok">{e.kind === 'order' ? <>{t('inbox.orderN', { n: e.number })} · <Pill tone={STATUS_TONE[e.status]}>{t(`status.${e.status}`)}</Pill> {t.money(e.total)}{e.source === 'ai' && ' — AI'}</>
                    : e.kind === 'comment' ? t('cu.commented', { text: e.text.slice(0, 40), post: e.post.slice(0, 30) }) : e.text.slice(0, 80)}</span>
                  <small>{t.agoLong(e.at)}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="small muted">{t('cu.noTimeline')}</p>}
      </section>

      <section>
        <h3 className="cu-h">{t('inbox.teamNote')}</h3>
        {c.notes.map((n) => <p key={n.id} className="team-note bn-ok">{n.text}{n.by && <> — {n.by}</>}</p>)}
        <form onSubmit={addNote}><input className="input input-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('inbox.addNote')} aria-label={t('inbox.addNote')} /></form>
      </section>

      <section>
        <h3 className="cu-h">{t('inbox.tags')}</h3>
        <div className="chips">
          {c.tags.map((x) => <span key={x} className="pill pill-gray tag">{x}<button type="button" aria-label={t('inbox.removeTag', { tag: x })} onClick={() => tag(true, x)}>×</button></span>)}
          <button type="button" className="chip chip-sm chip-add" onClick={() => tag(false)}>+ {t('inbox.tag')}</button>
        </div>
      </section>
    </aside>
  );
}
