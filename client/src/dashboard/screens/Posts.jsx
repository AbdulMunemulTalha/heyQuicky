import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Chips, Empty, ErrorState, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import { RichMessage } from '../ui/rich.jsx';
import '../ui/rich.css';
import './posts.css';

const FILTERS = ['all', 'linked', 'suggested', 'none'];
const SWITCHES = ['ai_reply', 'hide_spam', 'hide_phones', 'dm_cards'];
const LATER = ['remind', 'reactions']; // P2 automations shown in the frame, not built yet
const PLATFORM = { facebook: 'Facebook', instagram: 'Instagram' };

// The post's picture; without one (not synced yet), the first product's photo or colour.
function cover(image, products) {
  const first = products?.[0];
  if (image) return { backgroundImage: `url("${image}")` };
  if (first?.image) return { backgroundImage: `url("${first.image}")` };
  return first?.colour ? { background: first.colour } : undefined;
}

function statusPill(t, p) {
  if (p.products.length) return <Pill tone="green">{p.products.length > 1 ? t('po.linkedN', { n: t.num(p.products.length) }) : t('po.linked')}</Pill>;
  if (p.suggested.length) return <Pill tone="yellow">{t('po.checkN', { n: t.num(p.suggested.length) })}</Pill>;
  return <Pill tone="red">{t('po.noProduct')}</Pill>;
}

// Phase 2 · Posts (CAT-06 / CMT-02 / CMT-05), frame "Posts → products": Facebook and Instagram
// posts as picture cards; the chosen post's products, replies and automation in a side panel.
export default function Posts({ query }) {
  const t = useT();
  const { socket, can } = useDash();
  const filter = FILTERS.includes(query.filter) ? query.filter : 'all';
  const selected = Number(query.post) || null;
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const load = useCallback(() => dash(`/posts?filter=${filter}`).then(setD, setError), [filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('post', load);
    return () => socket.off('post', load);
  }, [socket, load]);

  async function sync() {
    setSyncing(true);
    try {
      const r = await dash('/posts/sync', { method: 'POST' });
      const bad = r.results.find((x) => x.error);
      if (bad) toast(bad.error, 'red');
      else if (r.results.every((x) => x.skipped)) toast(t('po.syncTest'));
      else toast(t('po.synced', { n: t.num(r.results.reduce((s, x) => s + x.synced, 0)), m: t.num(r.matched) }), 'green');
      load();
    } catch (err) { toast(err.message, 'red'); }
    setSyncing(false);
  }

  if (error) return <ErrorState thing={t('po.title')} error={error} onRetry={load} />;
  const edit = can('edit_products');
  return (
    <div className={`posts${selected ? ' with-panel' : ''}`}>
      <div className="po-main">
        <header className="page-head">
          <div><h1>{t('po.title')}</h1><p className="page-sub">{t('po.sub')}</p></div>
          <div className="page-actions">{edit && <Button busy={syncing} onClick={sync}>{t('po.sync')}</Button>}</div>
        </header>
        <div className="po-filters">
          <Chips label={t('po.filter')} value={filter} onChange={(v) => setQuery({ filter: v === 'all' ? null : v })}
            items={FILTERS.map((f) => ({ key: f, label: t(`po.f.${f}`), count: d?.counts[f] }))} />
        </div>
        {!d ? <div className="po-grid">{[0, 1, 2].map((i) => <Skeleton key={i} h={210} r={12} />)}</div> : d.posts.length === 0 ? (
          <div className="card"><Empty icon="catalog" title={t(filter === 'all' ? 'po.empty' : 'po.emptyFilter')}>{t('po.emptySub')}</Empty></div>
        ) : (
          <ul className="po-grid">
            {d.posts.map((p) => (
              <li key={p.id}>
                <button type="button" className={`po-card${selected === p.id ? ' on' : ''}`} onClick={() => setQuery({ post: p.id })} aria-pressed={selected === p.id}>
                  <span className="po-img" style={cover(p.image, p.products.length ? p.products : p.suggested)} aria-hidden="true">
                    <span className="po-badge">{PLATFORM[p.platform] ?? p.platform}</span>
                  </span>
                  <span className="po-body">
                    <strong className="bn-ok po-cap">{p.caption || t('po.noCaption')}</strong>
                    <small className="muted">{t.date(p.postedAt)} · {t('po.comments', { n: t.num(p.comments) })}</small>
                    <span className="po-tags">{statusPill(t, p)}{!p.aiReply && <Pill tone="gray">{t('po.aiOff')}</Pill>}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected && <Detail key={selected} t={t} id={selected} edit={edit} onChanged={load} />}
    </div>
  );
}

function Detail({ t, id, edit, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [custom, setCustom] = useState(null);
  const [editReply, setEditReply] = useState(false);
  const [showDm, setShowDm] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dash(`/posts/${id}`).then((x) => { setD(x); setCustom(x.rules.public_reply); }, setError), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!adding) return undefined;
    const timer = setTimeout(() => dash(`/catalog/pick?type=products&q=${encodeURIComponent(q)}`).then(setFound).catch(() => {}), 250);
    return () => clearTimeout(timer);
  }, [q, adding]);
  const close = () => setQuery({ post: null });

  if (error) return <aside className="po-panel"><ErrorState thing={t('po.title')} error={error} onRetry={load} back={close} /></aside>;
  if (!d) return <aside className="po-panel"><Skeleton h={320} r={12} /></aside>;
  const ids = d.products.map((p) => p.id);
  async function setProducts(next, ok) {
    try { await dash(`/posts/${id}/products`, { method: 'PUT', body: { productIds: next } }); if (ok) toast(ok, 'green'); load(); onChanged(); } catch (err) { toast(err.message, 'red'); }
  }
  async function match() {
    setBusy(true);
    try {
      const r = await dash(`/posts/${id}/match`, { method: 'POST' });
      toast(r.suggested.length ? t('po.matchFound', { n: t.num(r.suggested.length) }) : t('po.matchNone'), r.suggested.length ? 'green' : undefined);
      load(); onChanged();
    } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function rules(body, ok) {
    try { await dash(`/posts/${id}/rules`, { method: 'PATCH', body }); if (ok) toast(ok, 'green'); load(); onChanged(); } catch (err) { toast(err.message, 'red'); }
  }
  const p = d.post;
  const publicText = (v) => {
    if (!v) return '';
    if (v.startsWith('range:')) { const [, a, b] = v.split(':'); return t('po.publicRange', { min: t.money(Number(a)), max: t.money(Number(b)) }); }
    if (v.startsWith('price:')) return t('po.publicPrice', { price: t.money(Number(v.split(':')[1])) });
    return v;
  };
  return (
    <aside className="po-panel" aria-label={t('po.title')}>
      <div className="po-hero" style={cover(p.image, d.products.length ? d.products : d.suggested)}>
        <button type="button" className="po-close" onClick={close} aria-label={t('common.close')}>×</button>
      </div>
      <div className="po-pbody">
        <div>
          <p className="bn-ok po-caption">{p.caption || t('po.noCaption')}</p>
          <small className="muted">
            {PLATFORM[p.platform] ?? p.platform} · {t.date(p.postedAt)} · {t('po.comments', { n: t.num(p.comments) })} · <button type="button" className="linklike" onClick={() => navigate(`/comments/${p.id}`)}>{t('po.seeComments')}</button>
          </small>
        </div>

        <section className="po-sec">
          <div className="po-sechead"><h3>{t('po.products')}</h3>{edit && <Button size="sm" onClick={() => { setAdding(!adding); setQ(''); }}>{t('po.add')}</Button>}</div>
          {adding && (
            <div className="po-add">
              <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('po.searchProducts')} aria-label={t('po.searchProducts')} autoFocus />
              <ul>
                {found.filter((x) => !ids.includes(x.id)).slice(0, 8).map((x) => (
                  <li key={x.id}><button type="button" onClick={() => { setProducts([...ids, x.id]); setAdding(false); }}>{x.name} <span className="muted">· {t.money(x.price)}</span></button></li>
                ))}
              </ul>
            </div>
          )}
          {d.suggested.length > 0 && (
            <div className="po-suggest">
              <strong className="small">{t(p.matchSource === 'caption' ? 'po.suggestCaption' : 'po.suggestAi')}</strong>
              {d.suggested.map((x) => (
                <div key={x.id} className="po-prod">
                  <span className="po-swatch" style={x.image ? { backgroundImage: `url("${x.image}")` } : { background: x.colour || 'var(--gray-soft)' }} aria-hidden="true" />
                  <span className="grow"><strong className="small">{x.name}</strong><small className="muted">{t.money(x.price)}</small></span>
                </div>
              ))}
              {edit && <Button size="sm" variant="primary" onClick={() => setProducts(d.suggested.map((x) => x.id), t('po.confirmed'))}>{t('po.confirm')}</Button>}
            </div>
          )}
          {d.products.length === 0 && d.suggested.length === 0 && <p className="muted small">{t('po.noProductsHint')}</p>}
          {d.products.map((x) => (
            <div key={x.id} className="po-prod boxed">
              <span className="po-swatch" style={x.image ? { backgroundImage: `url("${x.image}")` } : { background: x.colour || 'var(--gray-soft)' }} aria-hidden="true" />
              <span className="grow"><strong className="small">{x.name}</strong><small className="muted">{t.money(x.price)}{!x.inStock && ` · ${t('po.out')}`}</small></span>
              <Pill tone={x.source === 'you' ? 'green' : 'blue'}>{t(`po.src.${x.source}`)}</Pill>
              {edit && <button type="button" className="po-x" onClick={() => setProducts(ids.filter((i) => i !== x.id))} aria-label={t('po.removeProduct', { n: x.name })}>×</button>}
            </div>
          ))}
          {edit && d.products.length === 0 && <Button size="sm" busy={busy} onClick={match}>{t(d.aiReady ? 'po.matchAi' : 'po.matchCaption')}</Button>}
        </section>

        <section className="po-sec">
          <h3>{t('po.sends')}</h3>
          {!d.preview ? <p className="muted small">{t('po.sendsNone')}</p> : (
            <>
              <div className="po-box">
                <div className="po-boxhead"><small className="muted">{t('po.public')}</small>{edit && <button type="button" className="linklike small" onClick={() => setEditReply((v) => !v)}>{t(editReply ? 'common.cancel' : 'common.edit')}</button>}</div>
                {editReply ? (
                  <div className="po-custom">
                    <input className="input input-sm" value={custom ?? ''} onChange={(e) => setCustom(e.target.value)} placeholder={t('po.customPlaceholder')} aria-label={t('po.custom')} maxLength={300} autoFocus />
                    <Button size="sm" variant="primary" disabled={(custom ?? '') === d.rules.public_reply} onClick={async () => { await rules({ public_reply: custom ?? '' }, t('common.saved')); setEditReply(false); }}>{t('common.save')}</Button>
                  </div>
                ) : <p className="bn-ok">{publicText(d.preview.public)}</p>}
              </div>
              <div className="po-box">
                <div className="po-boxhead"><small className="muted">{t('po.private')}</small>
                  {d.preview.dm.kind === 'cards' && <button type="button" className="linklike small" onClick={() => setShowDm((v) => !v)}>{t(showDm ? 'po.hidePreview' : 'po.showPreview')}</button>}</div>
                <p>{d.preview.dm.kind === 'cards' ? t(d.products.length > 1 ? 'po.dmCarousel' : 'po.dmCard', { n: t.num(d.products.length) }) : t(p.channelPlatform === 'instagram' ? 'po.dmTextIg' : 'po.dmText')}</p>
                {showDm && d.preview.dm.kind === 'cards' && <div className="po-dm"><RichMessage kind={d.preview.dm.rich.kind} payload={d.preview.dm.rich.payload} text={d.preview.dm.rich.text} /></div>}
              </div>
            </>
          )}
        </section>

        <section className="po-sec">
          <h3>{t('po.automation')}</h3>
          <ul className="po-switches">
            {SWITCHES.map((k) => (
              <li key={k}>
                <div className="grow"><strong className="small">{t(`po.sw.${k}`)}</strong><small className="muted">{t(`po.swHint.${k}`)}</small></div>
                <Toggle checked={d.rules[k]} disabled={!edit || (k === 'dm_cards' && p.channelPlatform === 'instagram')} onChange={(on) => rules({ [k]: on })} label={t(`po.sw.${k}`)} />
              </li>
            ))}
            {LATER.map((k) => (
              <li key={k} className="later">
                <div className="grow"><strong className="small">{t(`po.later.${k}`)}</strong><small className="muted">{t(`po.laterHint.${k}`)} · {t('po.comingLater')}</small></div>
                <Toggle checked={false} disabled label={t(`po.later.${k}`)} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
