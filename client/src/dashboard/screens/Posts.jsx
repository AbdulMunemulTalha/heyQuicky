import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Card, Chips, Empty, ErrorState, Pill, Segmented, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import { RichMessage } from '../ui/rich.jsx';
import '../ui/rich.css';
import './comments.css';
import './posts.css';

const FILTERS = ['all', 'linked', 'suggested', 'none'];
const SWITCHES = ['ai_reply', 'hide_spam', 'hide_phones', 'dm_cards'];

// Phase 2 · Posts (CAT-06 / CMT-02 / CMT-05): products in each post, what the AI sends, comment automation.
export default function Posts({ query }) {
  const t = useT();
  const { socket, can } = useDash();
  const platform = query.platform === 'instagram' ? 'instagram' : 'facebook';
  const filter = FILTERS.includes(query.filter) ? query.filter : 'all';
  const selected = Number(query.post) || null;
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const load = useCallback(() => dash(`/posts?platform=${platform}&filter=${filter}`).then(setD, setError), [platform, filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('post', load);
    return () => socket.off('post', load);
  }, [socket, load]);
  useEffect(() => {
    if (!selected && d?.posts[0]) setQuery({ post: d.posts[0].id });
  }, [d, selected]);

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
    <div className="posts">
      <header className="page-head">
        <div><h1>{t('po.title')}</h1><p className="page-sub">{t('po.sub')}</p></div>
        <div className="page-actions">
          <Segmented label={t('po.platform')} value={platform} onChange={(v) => setQuery({ platform: v === 'facebook' ? null : v, post: null })}
            items={[{ key: 'facebook', label: 'Facebook' }, { key: 'instagram', label: 'Instagram' }]} />
          {edit && <Button variant="dark" busy={syncing} onClick={sync}>{t('po.sync')}</Button>}
        </div>
      </header>
      <div className="po-layout">
        <Card pad={false} className="po-listcard">
          <div className="po-filters">
            <Chips label={t('po.filter')} value={filter} onChange={(v) => setQuery({ filter: v === 'all' ? null : v, post: null })}
              items={FILTERS.map((f) => ({ key: f, label: t(`po.f.${f}`), count: d?.counts[f] }))} />
          </div>
          {!d ? <div style={{ padding: 16 }}><Skeleton h={60} r={10} /></div> : d.posts.length === 0 ? (
            <Empty icon="catalog" title={t(filter === 'all' ? 'po.empty' : 'po.emptyFilter')}>{t('po.emptySub')}</Empty>
          ) : (
            <ul className="po-list">
              {d.posts.map((p) => (
                <li key={p.id}>
                  <button type="button" className={`cm-post${selected === p.id ? ' on' : ''}`} onClick={() => setQuery({ post: p.id })}>
                    <span className="cm-thumb" style={p.image ? { backgroundImage: `url("${p.image}")` } : undefined} aria-hidden="true" />
                    <span className="grow">
                      <strong className="bn-ok">{p.caption || t('po.noCaption')}</strong>
                      <small className="muted">{t.ago(p.postedAt)} · {t('po.comments', { n: t.num(p.comments) })}{p.aiReplied ? ` · ${t('po.aiReplied', { n: t.num(p.aiReplied) })}` : ''}</small>
                      <span className="po-tags">
                        {p.products.length > 0 ? p.products.slice(0, 2).map((x) => <Pill key={x.id} tone="green">{x.name}</Pill>)
                          : p.suggested.length > 0 ? <Pill tone="blue">{t('po.suggests', { n: t.num(p.suggested.length) })}</Pill>
                            : <Pill tone="gray">{t('po.noProducts')}</Pill>}
                        {p.products.length > 2 && <Pill tone="green">+{t.num(p.products.length - 2)}</Pill>}
                        {!p.aiReply && <Pill tone="yellow">{t('po.aiOff')}</Pill>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected ? <Detail key={selected} t={t} id={selected} edit={edit} onChanged={load} /> : (
          <Card className="po-none"><Empty icon="catalog" title={t('po.pick')} /></Card>
        )}
      </div>
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
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dash(`/posts/${id}`).then((x) => { setD(x); setCustom(x.rules.public_reply); }, setError), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!adding) return undefined;
    const timer = setTimeout(() => dash(`/catalog/pick?type=products&q=${encodeURIComponent(q)}`).then(setFound).catch(() => {}), 250);
    return () => clearTimeout(timer);
  }, [q, adding]);

  if (error) return <Card className="po-detail"><ErrorState thing={t('po.title')} error={error} onRetry={load} /></Card>;
  if (!d) return <Card className="po-detail"><Skeleton h={320} r={12} /></Card>;
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
    <div className="po-detail">
      <Card>
        <div className="cm-head po-head">
          <span className="cm-thumb lg" style={p.image ? { backgroundImage: `url("${p.image}")` } : undefined} aria-hidden="true" />
          <div className="grow">
            <p className="bn-ok po-caption">{p.caption || t('po.noCaption')}</p>
            <small className="muted">{p.channelName} · {t.agoLong(p.postedAt)} · {t('po.comments', { n: t.num(p.comments) })}</small>
          </div>
          <Button size="sm" onClick={() => navigate(`/comments/${p.id}`)}>{t('po.openComments')}</Button>
        </div>
      </Card>

      <Card title={t('po.products')} action={edit && <Button size="sm" onClick={() => { setAdding(!adding); setQ(''); }}>{t('po.add')}</Button>}>
        {d.suggested.length > 0 && (
          <div className="po-suggest">
            <div className="grow">
              <strong className="small">{t(d.post.matchSource === 'caption' ? 'po.suggestCaption' : 'po.suggestAi')}</strong>
              <div className="po-tags">{d.suggested.map((x) => <Pill key={x.id} tone="blue">{x.name} · {t.money(x.price)}</Pill>)}</div>
            </div>
            {edit && <Button size="sm" variant="primary" onClick={() => setProducts(d.suggested.map((x) => x.id), t('po.confirmed'))}>{t('po.confirm')}</Button>}
          </div>
        )}
        {d.products.length === 0 ? (
          <p className="muted small">{t('po.noProductsHint')}</p>
        ) : (
          <ul className="po-products">
            {d.products.map((x) => (
              <li key={x.id}>
                <span className="po-swatch" style={x.image ? { backgroundImage: `url("${x.image}")` } : { background: x.colour || 'var(--gray-soft)' }} aria-hidden="true" />
                <span className="grow"><strong className="small">{x.name}</strong><small className="muted">{t.money(x.price)}{!x.inStock && ` · ${t('po.out')}`}</small></span>
                <Pill tone={x.source === 'you' ? 'green' : 'blue'}>{t(`po.src.${x.source}`)}</Pill>
                {edit && <Button size="sm" variant="ghost" onClick={() => setProducts(ids.filter((i) => i !== x.id))}>{t('common.delete')}</Button>}
              </li>
            ))}
          </ul>
        )}
        {adding && (
          <div className="po-add">
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('po.searchProducts')} aria-label={t('po.searchProducts')} autoFocus />
            <ul>
              {found.filter((x) => !ids.includes(x.id)).slice(0, 8).map((x) => (
                <li key={x.id}><button type="button" onClick={() => { setProducts([...ids, x.id]); setAdding(false); }}>{x.name} <span className="muted">· {t.money(x.price)}</span></button></li>
              ))}
            </ul>
          </div>
        )}
        {edit && (
          <div className="po-matchrow">
            <Button size="sm" busy={busy} onClick={match}>{t(d.aiReady ? 'po.matchAi' : 'po.matchCaption')}</Button>
            <small className="muted">{t(d.aiReady ? 'po.matchAiHint' : 'po.matchCaptionHint')}</small>
          </div>
        )}
        {d.range && d.products.length > 1 && <p className="small po-range">{t('po.range', { min: t.money(d.range.min), max: t.money(d.range.max) })}</p>}
      </Card>

      <Card title={t('po.sends')}>
        {!d.preview ? <p className="muted small">{t('po.sendsNone')}</p> : (
          <div className="po-sends">
            <div>
              <span className="small muted">{t('po.public')}</span>
              <div className="po-comment"><span className="po-avatar" aria-hidden="true" /><div className="bubble-c bn-ok">{publicText(d.preview.public)}</div></div>
              {edit && (
                <div className="po-custom">
                  <input className="input" value={custom ?? ''} onChange={(e) => setCustom(e.target.value)} placeholder={t('po.customPlaceholder')} aria-label={t('po.custom')} maxLength={300} />
                  <Button size="sm" disabled={(custom ?? '') === d.rules.public_reply} onClick={() => rules({ public_reply: custom ?? '' }, t('common.saved'))}>{t('common.save')}</Button>
                </div>
              )}
              <small className="faint">{t(d.rules.public_reply ? 'po.customOn' : 'po.customOff')}</small>
            </div>
            <div>
              <span className="small muted">{t('po.private')}</span>
              {d.preview.dm.kind === 'cards'
                ? <div className="po-dm"><RichMessage kind={d.preview.dm.rich.kind} payload={d.preview.dm.rich.payload} text={d.preview.dm.rich.text} /></div>
                : <p className="small muted">{t(p.channelPlatform === 'instagram' ? 'po.dmTextIg' : 'po.dmText')}</p>}
            </div>
          </div>
        )}
      </Card>

      <Card title={t('po.automation')} pad={false}>
        <ul className="po-switches">
          {SWITCHES.map((k) => (
            <li key={k}>
              <div className="grow"><strong className="small">{t(`po.sw.${k}`)}</strong><small className="muted">{t(`po.swHint.${k}`)}</small></div>
              <Toggle checked={d.rules[k]} disabled={!edit || (k === 'dm_cards' && p.channelPlatform === 'instagram')} onChange={(on) => rules({ [k]: on })} label={t(`po.sw.${k}`)} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
