import { useCallback, useEffect, useMemo, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Button, ErrorState, Skeleton, toast } from '../ui/kit.jsx';
import './content.css';

// Phase 3 · Content studio (CMT-06), frame "AI post generator & content studio".
const DHAKA_MS = 6 * 3_600_000;
const dhaka = (iso) => { const l = new Date(new Date(iso).getTime() + DHAKA_MS); return { date: l.toISOString().slice(0, 10), time: l.toISOString().slice(11, 16) }; };
const todayDhaka = () => dhaka(new Date()).date;
const TONE = { posted: 'green', scheduled: 'blue', draft: 'yellow', ready: 'red', failed: 'red', posting: 'blue' };

export default function Content() {
  const t = useT();
  const { can } = useDash();
  const [month, setMonth] = useState(todayDhaka().slice(0, 7));
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState({ date: todayDhaka(), post: null });
  const load = useCallback(() => dash(`/content?month=${month}`).then(setD, setError), [month]);
  useEffect(() => { load(); }, [load]);
  const days = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const start = new Date(first.getTime() - first.getUTCDay() * 86_400_000);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  }, [month]);
  if (error) return <ErrorState thing={t('cs.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={480} r={12} />;
  const byDay = {};
  for (const p of d.posts) { const key = p.scheduledAt ? dhaka(p.scheduledAt).date : 'unscheduled'; (byDay[key] ??= []).push(p); }
  const shift = (n) => { const [y, m] = month.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(x.toISOString().slice(0, 7)); };
  const monthName = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const today = todayDhaka();
  return (
    <div className="cs">
      <div className="cs-main">
        <header className="cs-head">
          <div><h1>{t('cs.title')}</h1><p className="page-sub">{t('cs.sub')}</p></div>
          <div className="row cs-month"><button type="button" className="cs-nav" onClick={() => shift(-1)} aria-label={t('cs.prev')}>‹</button><strong>{monthName}</strong><button type="button" className="cs-nav" onClick={() => shift(1)} aria-label={t('cs.next')}>›</button></div>
        </header>
        <div className="cs-cal card" role="grid" aria-label={monthName}>
          {['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => <span key={k} className="cs-dow" role="columnheader">{t(`bk.day.${k}`)}</span>)}
          {days.map((date) => {
            const inMonth = date.startsWith(month);
            return (
              <div key={date} role="gridcell" className={`cs-day${inMonth ? '' : ' out'}${date === today ? ' today' : ''}${sel.date === date && !sel.post ? ' on' : ''}`}>
                <button type="button" className="cs-num" onClick={() => setSel({ date, post: null })} aria-label={t('cs.newOn', { date })}>{Number(date.slice(8))}</button>
                {(byDay[date] ?? []).slice(0, 3).map((p) => (
                  <button key={p.id} type="button" className={`cs-chip tone-${TONE[p.status]}${sel.post?.id === p.id ? ' on' : ''}`} onClick={() => setSel({ date, post: p })} title={p.text}>
                    {p.text.split('\n')[0].slice(0, 24)}
                  </button>
                ))}
                {(byDay[date]?.length ?? 0) > 3 && <small className="muted">+{byDay[date].length - 3}</small>}
              </div>
            );
          })}
        </div>
        <div className="cs-legend small muted"><span><i className="tone-green" />{t('cs.st.posted')}</span><span><i className="tone-blue" />{t('cs.st.scheduled')}</span><span><i className="tone-yellow" />{t('cs.st.draft')}</span><span><i className="tone-red" />{t('cs.st.ready')}</span></div>
        {byDay.unscheduled?.length > 0 && (
          <div className="cs-drafts"><h3>{t('cs.unscheduled')}</h3>
            {byDay.unscheduled.map((p) => <button key={p.id} type="button" className={`cs-chip tone-${TONE[p.status]}`} onClick={() => setSel({ date: today, post: p })}>{p.text.split('\n')[0].slice(0, 40)}</button>)}
          </div>
        )}
      </div>
      <Panel key={sel.post?.id ?? sel.date} t={t} d={d} date={sel.date} post={sel.post} canEdit={can('reply')} onSaved={(p) => { setSel({ date: p.scheduledAt ? dhaka(p.scheduledAt).date : sel.date, post: p }); load(); }} onDeleted={() => { setSel({ date: sel.date, post: null }); load(); }} />
    </div>
  );
}

function Panel({ t, d, date, post, canEdit, onSaved, onDeleted }) {
  const [f, setF] = useState(() => ({
    productId: post?.productId ?? d.products[0]?.id ?? '', topic: post?.topic ?? '', tone: post?.tone ?? 'warm', text: post?.text ?? '',
    date: post?.scheduledAt ? dhaka(post.scheduledAt).date : date, time: post?.scheduledAt ? dhaka(post.scheduledAt).time : d.bestTime,
    platforms: post?.platforms ?? [d.channels.facebook && 'facebook', d.channels.instagram && 'instagram'].filter(Boolean), linkProduct: post?.linkProduct ?? true,
  }));
  const [versions, setVersions] = useState([]);
  const [busy, setBusy] = useState('');
  const product = d.products.find((p) => p.id === Number(f.productId));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const locked = post && ['posted', 'posting'].includes(post.status);
  const future = new Date(`${f.date}T${f.time}:00+06:00`) > new Date();
  async function write() {
    setBusy('write');
    try { const r = await dash('/content/write', { method: 'POST', body: { productId: f.productId || null, topic: f.topic, tone: f.tone } }); setVersions(r.versions); if (r.versions[0]) setF((x) => ({ ...x, text: r.versions[0] })); } catch (err) { toast(err.message, 'red'); } finally { setBusy(''); }
  }
  async function save(status) {
    setBusy(status);
    try {
      const body = { ...f, productId: f.productId || null, status, fromAi: versions.length > 0 };
      const p = post ? await dash(`/content/posts/${post.id}`, { method: 'PATCH', body }) : await dash('/content/posts', { method: 'POST', body });
      toast(t(status === 'scheduled' ? 'cs.scheduledToast' : 'cs.savedToast'), 'green');
      onSaved(p);
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(''); }
  }
  async function postNow() {
    setBusy('now');
    try {
      const saved = post ?? await dash('/content/posts', { method: 'POST', body: { ...f, productId: f.productId || null, status: 'draft', fromAi: versions.length > 0 } });
      const p = await dash(`/content/posts/${saved.id}/publish`, { method: 'POST' });
      toast(p.status === 'posted' ? t('cs.postedToast') : p.error, p.status === 'posted' ? 'green' : 'yellow');
      onSaved(p);
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(''); }
  }
  async function copyOpen() {
    await navigator.clipboard?.writeText(post.text).catch(() => {});
    toast(t('cs.copied'), 'green');
    window.open('https://www.facebook.com/', '_blank', 'noopener');
  }
  async function markPosted() { try { onSaved(await dash(`/content/posts/${post.id}/posted`, { method: 'POST' })); } catch (err) { toast(err.message, 'red'); } }
  async function remove() { try { await dash(`/content/posts/${post.id}`, { method: 'DELETE' }); toast(t('cs.deleted'), 'green'); onDeleted(); } catch (err) { toast(err.message, 'red'); } }
  const dayLabel = new Date(`${f.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <aside className="cs-panel" aria-label={t('cs.panel')}>
      <h2>{post ? t(`cs.st.${post.status}`) : t('cs.newPost', { day: dayLabel })}</h2>
      {post?.error && <p className="cs-err small">{post.error}</p>}
      {post?.status === 'ready' && canEdit && <div className="row" style={{ gap: 8 }}><Button size="sm" variant="primary" onClick={copyOpen}>{t('cs.copyOpen')}</Button><Button size="sm" onClick={markPosted}>{t('cs.markPosted')}</Button></div>}
      <div className="field"><label htmlFor="cs-product">{t('cs.product')}</label>
        <select id="cs-product" value={f.productId} onChange={set('productId')} disabled={locked}><option value="">{t('cs.noProduct')}</option>{d.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {product && (
        <div className="cs-prod">{product.photo ? <img src={product.photo} alt="" /> : <span style={{ background: product.colour || '#5b4b8a' }} />}<span className="grow"><strong>{product.name}</strong><small className="muted">{t.money(product.price)}{product.stock != null ? ` · ${t('cs.inStock', { n: product.stock })}` : ''}</small></span></div>
      )}
      <div className="field"><label htmlFor="cs-topic">{t('cs.about')}</label><input id="cs-topic" value={f.topic} onChange={set('topic')} placeholder={t('cs.aboutPh')} maxLength={300} disabled={locked} /></div>
      <div className="field"><span className="lbl">{t('cs.tone')}</span>
        <div className="cs-tones" role="radiogroup" aria-label={t('cs.tone')}>{d.tones.map((k) => <button key={k} type="button" role="radio" aria-checked={f.tone === k} className={`cs-tone${f.tone === k ? ' on' : ''}`} onClick={() => setF((x) => ({ ...x, tone: k }))} disabled={locked}>{t(`cs.tone.${k}`)}</button>)}</div>
      </div>
      {!locked && <Button onClick={write} busy={busy === 'write'} disabled={!d.aiReady || (!f.productId && !f.topic.trim())} title={!d.aiReady ? t('cs.noAi') : undefined}>✨ {versions.length ? t('cs.writeAgain') : t('cs.write')}</Button>}
      {versions.length > 0 && (
        <div className="cs-versions" role="radiogroup" aria-label={t('cs.versions')}>
          <small className="muted">{t('cs.aiWrote', { n: versions.length })}</small>
          {versions.map((v, i) => <button key={i} type="button" role="radio" aria-checked={f.text === v} className={`cs-version bn-ok${f.text === v ? ' on' : ''}`} onClick={() => setF((x) => ({ ...x, text: v }))}>{v}</button>)}
        </div>
      )}
      <div className="field"><label htmlFor="cs-text">{t('cs.text')}</label><textarea id="cs-text" rows={5} className="bn-ok" value={f.text} onChange={set('text')} maxLength={2200} disabled={locked} /></div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field grow"><label htmlFor="cs-date">{t('cs.day')}</label><input id="cs-date" type="date" value={f.date} onChange={set('date')} disabled={locked} /></div>
        <div className="field grow"><label htmlFor="cs-time">{t('cs.time')}{f.time === d.bestTime ? ` · ${t('cs.best')}` : ''}</label><input id="cs-time" type="time" value={f.time} onChange={set('time')} disabled={locked} /></div>
      </div>
      <div className="field"><span className="lbl">{t('cs.postTo')}</span>
        <div className="cs-tones">{['facebook', 'instagram'].map((p) => {
          const on = f.platforms.includes(p);
          return <button key={p} type="button" aria-pressed={on} className={`cs-tone${on ? ' on' : ''}`} disabled={locked || !d.channels[p]} title={!d.channels[p] ? t('cs.notConnected') : undefined} onClick={() => setF((x) => ({ ...x, platforms: on ? x.platforms.filter((y) => y !== p) : [...x.platforms, p] }))}>{t(`cs.p.${p}`)}{on ? ' ✓' : ''}</button>;
        })}</div>
      </div>
      {product && <label className="cs-link small"><input type="checkbox" checked={f.linkProduct} onChange={(e) => setF((x) => ({ ...x, linkProduct: e.target.checked }))} disabled={locked} />{t('cs.linkProduct', { name: product.name })}</label>}
      {canEdit && !locked && (
        <div className="cs-actions">
          <Button busy={busy === 'draft'} disabled={!f.text.trim()} onClick={() => save('draft')}>{t('cs.saveDraft')}</Button>
          {future ? <Button variant="primary" busy={busy === 'scheduled'} disabled={!f.text.trim() || !f.platforms.length} onClick={() => save('scheduled')}>{t('cs.schedule')}</Button>
            : <Button variant="primary" busy={busy === 'now'} disabled={!f.text.trim() || !f.platforms.length} onClick={postNow}>{t('cs.postNow')}</Button>}
          {post && <Button className="cs-danger" onClick={remove}>{t('common.delete')}</Button>}
        </div>
      )}
      {locked && post.status === 'posted' && <p className="small muted">{t('cs.postedAt', { when: t.ago(post.postedAt) })}</p>}
    </aside>
  );
}
