import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Card, Checkbox, Empty, ErrorState, Kpi, Pill, Segmented, Skeleton, toast } from '../ui/kit.jsx';
import './growth.css';

const TABS = ['followups', 'leads', 'broadcasts'];
const TEMP_TONE = { hot: 'orange', warm: 'yellow', skip: 'gray', cold: 'gray' };

// Screen 05: follow-ups, leads and broadcasts.
export default function Growth({ query }) {
  const t = useT();
  const tab = TABS.includes(query.tab) ? query.tab : 'followups';
  return (
    <div className="growth">
      <header className="page-head">
        <div><h1>{t(`gr.title.${tab}`)}</h1><p className="page-sub">{t(`gr.sub.${tab}`)}</p></div>
        <Segmented label={t('nav.growth')} value={tab} onChange={(v) => setQuery({ tab: v === 'followups' ? null : v })}
          items={TABS.map((k) => ({ key: k, label: t(`gr.tab.${k}`) }))} />
      </header>
      {tab === 'followups' && <Followups t={t} />}
      {tab === 'leads' && <Leads t={t} query={query} />}
      {tab === 'broadcasts' && <Broadcasts t={t} />}
    </div>
  );
}

function Followups({ t }) {
  const { can, socket } = useDash();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash('/growth/followups').then(setData, setError), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('conversation', load);
    return () => socket.off('conversation', load);
  }, [socket, load]);

  async function setting(patch) {
    setData((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
    try { await dash('/growth/followups/settings', { method: 'PATCH', body: patch }); toast(t('common.saved')); } catch (err) { toast(err.message, 'red'); load(); }
  }

  if (error) return <ErrorState thing={t('gr.tab.followups')} error={error} onRetry={load} />;
  if (!data) return <Skeleton h={300} r={12} />;
  const k = data.kpis;
  const statusText = (f) => {
    if (f.status === 'skipped') return f.skipReason ? t('gr.st.skipReason', { r: f.skipReason }) : t('gr.st.noFollow');
    if (f.status === 'replied') return t('gr.st.replied');
    if (f.status === 'ordered') return t('gr.st.ordered');
    if (f.status === 'sent' && new Date(f.dueAt) <= new Date()) return t('gr.st.waiting');
    const when = new Date(f.dueAt);
    const soon = when - Date.now() < 3_600_000;
    return t(f.withOffer ? 'gr.st.reminderOffer' : 'gr.st.reminder', { n: f.status === 'sent' ? 2 : 1, when: soon ? t('gr.inMin', { n: Math.max(1, Math.round((when - Date.now()) / 60_000)) }) : t.dateTime(f.dueAt) });
  };
  const pill = (f) => (f.status === 'sent' ? ['blue', 'gr.p.sent'] : f.status === 'skipped' ? ['gray', 'gr.p.skip'] : f.status === 'replied' ? ['green', 'gr.p.replied'] : f.status === 'ordered' ? ['green', 'gr.p.ordered'] : [TEMP_TONE[f.temp], `gr.p.${f.temp}`]);
  return (
    <>
      <div className="kpis gr-kpis">
        <Kpi label={t('gr.k.watching')} value={t.num(k.watching)} />
        <Kpi label={t('gr.k.sentToday')} value={t.num(k.sentToday)} />
        <Kpi label={t('gr.k.replied')} value={<>{t.num(k.replied)} <small className="kpi-inline">{t.pct(k.repliedPct)}</small></>} />
        <Kpi label={t('gr.k.ordered')} value={<>{t.num(k.ordered)} · {t.money(k.orderedValue)}</>} />
      </div>
      <div className="gr-grid">
        <Card pad={false}>
          {data.items.length === 0 ? <Empty icon="growth" title={t('gr.noneTitle')}>{t('gr.noneSub')}</Empty> : (
            <ul className="gr-list">
              {data.items.map((f) => {
                const [tone, label] = pill(f);
                return (
                  <li key={f.id}>
                    <Pill tone={tone} className="gr-tag">{t(label)}</Pill>
                    <span className="grow"><strong>{f.name}</strong><small className="bn-ok muted">{f.lastMessage}</small></span>
                    <span className="small muted gr-when">{statusText(f)}</span>
                    <Button size="sm" onClick={() => navigate(`/inbox/${f.conversationId}`)}>{t('gr.open')}</Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title={t('gr.how')}>
          <div className="gr-how">
            <p>{t('gr.how1')}</p>
            <p><strong>{t('gr.p.hot')}</strong> — {t('gr.howHot')}</p>
            <p><strong>{t('gr.p.warm')}</strong> — {t('gr.howWarm')}</p>
            <p><strong>{t('gr.p.skip')}</strong> — {t('gr.howSkip')}</p>
            <p className="small muted">{t('gr.howMax')}<br />{t('gr.howWindow')}</p>
          </div>
          <div className="gr-opts">
            <Checkbox checked={data.settings.enabled} disabled={!can('teach_ai')} onChange={(v) => setting({ enabled: v })} label={t('gr.enabled')} />
            <Checkbox checked={data.settings.offer} disabled={!can('teach_ai') || !data.settings.enabled} onChange={(v) => setting({ offer: v })} label={t('gr.offer')} />
          </div>
        </Card>
      </div>
    </>
  );
}

function Leads({ t, query }) {
  const tab = query.leads === 'contacted' ? 'contacted' : 'to_chase';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const load = useCallback(() => dash(`/growth/leads?tab=${tab}`).then(setData, setError), [tab]);
  useEffect(() => { load(); }, [load]);

  async function log(lead, outcome) {
    try {
      await dash(`/growth/leads/${lead.id}/log`, { method: 'POST', body: { outcome } });
      toast(t(`gr.logged.${outcome}`), 'green');
      setLogFor(null);
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  if (error) return <ErrorState thing={t('gr.tab.leads')} error={error} onRetry={load} />;
  return (
    <Card pad={false}>
      <div className="tabs gr-tabs" role="tablist">
        {['to_chase', 'contacted'].map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setQuery({ leads: k === 'to_chase' ? null : k })}>
            {t(`gr.leads.${k}`)} <span className="tab-count">{data ? t.num(data.counts[k]) : ''}</span>
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="btn btn-link small" onClick={() => navigate('/growth/leads')}>{t('gr.pipeline')} →</button>
      </div>
      {!data ? <div className="pad"><Skeleton h={200} /></div> : data.items.length === 0 ? <Empty icon="customers" title={t('gr.noLeads')}>{t('gr.noLeadsSub')}</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('cu.col.customer')}</th><th>{t('gr.col.product')}</th><th>{t('gr.col.temp')}</th><th>{t('gr.col.asked')}</th><th>{t('gr.col.follow')}</th><th /></tr></thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.name}</strong><span className="sub num">{t.digits(l.phone)}</span></td>
                  <td>{l.product || <span className="faint">—</span>}{l.amount ? <span className="sub">{t.money(l.amount)}</span> : null}</td>
                  <td><Pill tone={TEMP_TONE[l.temp]}>{t(`gr.p.${l.temp}`)}</Pill></td>
                  <td className="num">{t('gr.times', { n: l.timesAsked })}<span className="sub">{t.agoLong(l.lastSeenAt)}</span></td>
                  <td className="small">{l.followUpAt ? t.dateTime(l.followUpAt) : <span className="faint">—</span>}{l.outcome && <span className="sub">{t(`gr.out.${l.outcome}`)}{l.owner && ` · ${l.owner}`}</span>}</td>
                  <td className="nowrap gr-actions">
                    {l.conversationId && <Button size="sm" onClick={() => navigate(`/inbox/${l.conversationId}`)}>{t('gr.open')}</Button>}
                    {l.canCall && <>
                      <Button size="sm" onClick={() => window.open(`https://wa.me/88${l.phone}`, '_blank', 'noopener')}>WhatsApp</Button>
                      <Button size="sm" onClick={() => { navigator.clipboard?.writeText(l.phone); toast(t('gr.copied')); }}>{t('gr.copy')}</Button>
                    </>}
                    <span className="log-wrap">
                      <Button size="sm" variant="dark" onClick={() => setLogFor(logFor === l.id ? null : l.id)}>{t('gr.logCall')}</Button>
                      {logFor === l.id && (
                        <span className="status-menu log-menu" role="menu">
                          {['ordered', 'call_later', 'no_answer', 'not_interested'].map((o) => <button key={o} type="button" role="menuitem" onClick={() => log(l, o)}>{t(`gr.out.${o}`)}</button>)}
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Broadcasts({ t }) {
  const { can } = useDash();
  const [audience, setAudience] = useState('last_24h');
  const [format, setFormat] = useState('text');
  const [text, setText] = useState('');
  const [buttons, setButtons] = useState(['অর্ডার করব', 'আরও দেখান', '']);
  const [productIds, setProductIds] = useState([]);
  const [image, setImage] = useState('');
  const [when, setWhen] = useState('');
  const [preview, setPreview] = useState(null);
  const [products, setProducts] = useState([]);
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(() => dash('/growth/broadcasts').then(setHistory).catch(() => setHistory([])), []);
  useEffect(() => { loadHistory(); dash('/orders/products').then(setProducts).catch(() => {}); }, [loadHistory]);
  useEffect(() => { dash('/growth/broadcasts/preview', { method: 'POST', body: { audience } }).then(setPreview).catch(() => setPreview(null)); }, [audience]);

  async function send(schedule) {
    setBusy(true);
    try {
      const r = await dash('/growth/broadcasts', { method: 'POST', body: { audience, format, content: { text, buttons, productIds, image }, scheduledAt: schedule ? new Date(when).toISOString() : null } });
      toast(r.scheduled ? t('gr.scheduledOk', { when: t.dateTime(when) }) : t('gr.sentOk', { n: r.sent }), 'green');
      setText('');
      loadHistory();
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(false); }
  }

  const needProducts = format === 'product' || format === 'carousel';
  const ready = text.trim() && (!needProducts || productIds.length) && preview?.recipients > 0;
  return (
    <div className="gr-grid">
      <Card title={t('gr.newBroadcast')}>
        <div className="field"><span className="label-like">{t('gr.who')}</span>
          <div className="of-zones gr-four" role="radiogroup">
            {['hot', 'warm', 'last_24h', 'customers_24h'].map((a) => (
              <button key={a} type="button" role="radio" aria-checked={audience === a} className={`of-zone${audience === a ? ' on-z' : ''}`} onClick={() => setAudience(a)}>
                <strong>{t(`gr.aud.${a}`)}</strong><small>{t(`gr.aud.${a}Sub`)}</small>
              </button>
            ))}
          </div>
          <p className="field-hint">{preview ? t('gr.recipients', { n: preview.recipients }) : '…'}{preview?.outsideWindow ? ` · ${t('gr.outside', { n: preview.outsideWindow })}` : ''}</p>
        </div>
        <div className="field" style={{ marginTop: 12 }}><span className="label-like">{t('gr.format')}</span>
          <div className="chips">{['text', 'buttons', 'product', 'carousel', 'photo'].map((f) => <button key={f} type="button" className={`chip${format === f ? ' on' : ''}`} onClick={() => setFormat(f)}>{t(`gr.fmt.${f}`)}</button>)}</div>
        </div>
        <div className="field" style={{ marginTop: 12 }}><label htmlFor="gr-msg">{t('gr.message')}</label>
          <textarea id="gr-msg" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('gr.msgPlaceholder')} maxLength={1000} />
          <p className="field-hint">{t.digits(text.length)}/{t.digits(1000)}</p>
        </div>
        {format === 'buttons' && (
          <div className="of-three">{buttons.map((b, i) => <input key={i} className="input" value={b} maxLength={20} placeholder={t('gr.button', { n: i + 1 })} onChange={(e) => setButtons((x) => x.map((y, j) => (j === i ? e.target.value : y)))} aria-label={t('gr.button', { n: i + 1 })} />)}</div>
        )}
        {needProducts && (
          <div className="gr-products">
            {products.slice(0, 12).map((p) => (
              <label key={p.id} className={`gr-product${productIds.includes(p.id) ? ' on-z' : ''}`}>
                <input type="checkbox" checked={productIds.includes(p.id)} onChange={(e) => setProductIds((ids) => (e.target.checked ? (format === 'product' ? [p.id] : [...ids, p.id].slice(0, 10)) : ids.filter((x) => x !== p.id)))} />
                <span className="od-swatch sm" style={{ background: p.colour }} /> {p.name} <span className="muted">{t.money(p.price)}</span>
              </label>
            ))}
          </div>
        )}
        {format === 'photo' && <input className="input" style={{ marginTop: 10 }} value={image} onChange={(e) => setImage(e.target.value)} placeholder={t('gr.imageUrl')} aria-label={t('gr.imageUrl')} />}
        <div className="gr-send">
          <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label={t('gr.when')} />
          <Button disabled={!ready || !when || !can('reply')} busy={busy} onClick={() => send(true)}>{t('gr.schedule')}</Button>
          <Button variant="primary" disabled={!ready || !can('reply')} busy={busy} onClick={() => send(false)}>{t('gr.sendNow', { n: preview?.recipients ?? 0 })}</Button>
        </div>
        <p className="small muted">{t('gr.ruleNote')}</p>
      </Card>
      <Card title={t('gr.history')}>
        {!history ? <Skeleton h={120} /> : history.length === 0 ? <p className="small muted">{t('gr.noHistory')}</p> : (
          <ul className="gr-history">
            {history.map((b) => (
              <li key={b.id}>
                <div className="row"><Pill tone={b.status === 'sent' ? 'green' : 'blue'}>{t(`gr.bst.${b.status}`)}</Pill><span className="small muted">{t.dateTime(b.sentAt ?? b.scheduledAt)}</span></div>
                <p className="bn-ok small">{b.text.slice(0, 90)}</p>
                <small className="muted">{t('gr.bstats', { r: b.stats.recipients, rep: b.stats.replied, o: b.stats.ordered })}</small>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
