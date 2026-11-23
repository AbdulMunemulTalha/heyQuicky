import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Link, navigate } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Card, ErrorState, Modal, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import { soft } from './Catalog.jsx';
import './catalog.css';

const BLANK = { name: '', code: '', price: '', compareAt: '', category: '', description: '', photos: [], video: '', options: [], variants: [], aiNotes: '',
  visibility: 'everywhere', sizeChartId: null, upsellIds: [], inStock: true, archived: false };
const VIS = ['everywhere', 'ai_only', 'hidden'];
const SWATCH = { red: '#c0392b', maroon: '#7a1f2b', rose: '#c76b7e', pink: '#e597b2', teal: '#2f7d74', green: '#2e8b57', olive: '#7b8b3a', blue: '#3b6fd8', navy: '#1f2f5c',
  sky: '#7fb3e6', black: '#222', white: '#f4f4f4', cream: '#efe4cc', beige: '#d9c6a5', brown: '#8a5a3b', yellow: '#e2b93b', mustard: '#c9a227', orange: '#e07b39',
  purple: '#6b4c9a', lavender: '#b9a6dc', grey: '#999', gray: '#999', golden: '#c9a227', gold: '#c9a227', silver: '#c0c0c0' };
// Bangla digits typed into money boxes become 0-9.
const digitsOnly = (s) => String(s).replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/D/g, '');
const isColour = (name) => /^(colou?r|রং|রঙ)$/i.test(name);
const keyOf = (opts, options) => JSON.stringify(Object.fromEntries(options.map((o) => [o.name, opts[o.name]])));
const skuPart = (s) => String(s).replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase();

// Every combination of the options, keeping what was already typed for combinations that still exist.
function combine(options, old, price, code) {
  if (!options.length) return [];
  let combos = [{}];
  for (const o of options) combos = combos.flatMap((c) => o.values.map((v) => ({ ...c, [o.name]: v })));
  const before = new Map(old.map((v) => [keyOf(v.options, options), v]));
  return combos.slice(0, 200).map((opts) => before.get(keyOf(opts, options))
    ?? { options: opts, sku: [skuPart(code || 'SKU'), ...options.map((o) => skuPart(opts[o.name]))].join('-'), price: price === '' ? '' : Number(price), stock: 0, reserved: 0 });
}

// Screen 13: add or edit a product.
export default function ProductForm({ params }) {
  const t = useT();
  const { can } = useDash();
  const id = params.id && params.id !== 'new' ? Number(params.id) : null;
  const [v, setV] = useState(id ? null : BLANK);
  const [extra, setExtra] = useState({ upsells: [], posts: [], sizeCharts: [], categories: [], stats: null });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [problems, setProblems] = useState({});
  const [bulk, setBulk] = useState(false);
  const edit = can('edit_products');

  const load = useCallback(async () => {
    try {
      if (id) {
        const d = await dash(`/catalog/products/${id}`);
        setV({ ...BLANK, ...d.product, compareAt: d.product.compareAt ?? '' });
        setExtra({ upsells: d.upsells, posts: d.posts, sizeCharts: d.sizeCharts, categories: d.categories, stats: d.stats });
      } else {
        const d = await dash('/catalog?filter=all');
        setExtra((x) => ({ ...x, categories: d.categories }));
      }
      setDirty(false);
    } catch (e) { setError(e); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = (k, val) => {
    setV((x) => {
      // Variants still on the old price (or blank) follow the main price; ones given their own price keep it.
      if (k === 'price') return { ...x, price: val, variants: x.variants.map((vr) => (vr.price === '' || String(vr.price) === String(x.price) ? { ...vr, price: val === '' ? '' : Number(val) } : vr)) };
      return { ...x, [k]: val };
    });
    setDirty(true);
  };
  const setOptions = (options) => setV((x) => { setDirty(true); return { ...x, options, variants: combine(options, x.variants, x.price, x.code) }; });

  if (error) return <ErrorState thing={t('cat.thisProduct')} error={error} onRetry={load} back={{ to: '/catalog', label: t('state.backTo.catalog') }} />;
  if (!v) return <Skeleton h={500} r={12} />;

  async function save() {
    const p = {};
    if (!v.name.trim()) p.name = t('cat.needName');
    if (v.price === '' || Number.isNaN(Number(v.price))) p.price = t('cat.needPrice');
    if (v.compareAt !== '' && Number(v.compareAt) <= Number(v.price)) p.compareAt = t('cat.compareHigher');
    setProblems(p);
    if (Object.keys(p).length) { document.getElementById(`pf-${Object.keys(p)[0]}`)?.focus(); return; }
    setSaving(true);
    try {
      const body = { ...v, compareAt: v.compareAt === '' ? null : v.compareAt };
      if (id) {
        await dash(`/catalog/products/${id}`, { method: 'PATCH', body });
        toast(t('cat.saved'), 'green');
        await load();
      } else {
        const r = await dash('/catalog/products', { method: 'POST', body });
        setDirty(false);
        toast(t('cat.added'), 'green');
        navigate(`/catalog/${r.id}`, { replace: true });
      }
    } catch (e) { toast(e.message, 'red'); } finally { setSaving(false); }
  }
  async function duplicate() {
    try { const r = await dash(`/catalog/products/${id}/duplicate`, { method: 'POST' }); toast(t('cat.duplicated'), 'green'); navigate(`/catalog/${r.id}`); } catch (e) { toast(e.message, 'red'); }
  }
  async function archive() {
    // eslint-disable-next-line no-alert
    if (!v.archived && !window.confirm(t('cat.archiveConfirm'))) return;
    try { await dash(`/catalog/products/${id}/archive`, { method: 'POST', body: { archived: !v.archived } }); toast(v.archived ? t('cat.restored') : t('cat.archivedToast'), 'green'); load(); } catch (e) { toast(e.message, 'red'); }
  }

  const statusTone = v.archived ? 'gray' : v.visibility === 'hidden' ? 'gray' : v.visibility === 'ai_only' ? 'blue' : 'green';
  const statusText = v.archived ? t('cat.f.archivedOne') : t(`cat.status.${v.visibility}`);
  return (
    <div className="pform">
      <header className="page-head">
        <div>
          <Link to="/catalog" className="small">← {t('nav.catalog')}</Link>
          <h1 className="row" style={{ gap: 10 }}><span className="bn-ok">{id ? v.name || t('cat.product') : t('cat.newProduct')}</span>{id && <Pill tone={statusTone}>{statusText}</Pill>}</h1>
        </div>
        <div className="page-actions">
          {id && edit && <Button onClick={duplicate}>{t('cat.duplicate')}</Button>}
          {id && (v.pageUrl && v.visibility === 'everywhere' && !v.archived
            ? <a className="btn btn-default" href={v.pageUrl} target="_blank" rel="noreferrer">{t('cat.preview')}</a>
            : <Button disabled title={t('cat.previewSoon')}>{t('cat.preview')}</Button>)}
          {edit && <Button variant="primary" busy={saving} onClick={save}>{id ? t('cat.saveChanges') : t('cat.addProduct')}</Button>}
        </div>
      </header>
      {dirty && <p className="small muted pf-dirty" role="status">{t('cat.unsaved')}</p>}

      <fieldset className="pf-grid" disabled={!edit}>
        <div className="od-col">
          <Card title={t('cat.basics')}>
            <div className="field"><label htmlFor="pf-name">{t('cat.name')}</label>
              <input id="pf-name" value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={120} aria-invalid={Boolean(problems.name)} />
              {problems.name && <span className="error-text small">{problems.name}</span>}</div>
            <div className="field"><label htmlFor="pf-desc">{t('cat.description')}</label>
              <textarea id="pf-desc" rows={4} value={v.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} className="bn-ok" />
              <span className="small muted">{t('cat.descHint')}</span></div>
            <div className="of-three">
              <div className="field"><label htmlFor="pf-price">{t('cat.price')}</label>
                <div className="pf-money"><span>৳</span><input id="pf-price" inputMode="numeric" value={v.price} onChange={(e) => set('price', digitsOnly(e.target.value))} aria-invalid={Boolean(problems.price)} /></div>
                {problems.price && <span className="error-text small">{problems.price}</span>}</div>
              <div className="field"><label htmlFor="pf-compareAt">{t('cat.compareAt')}</label>
                <div className="pf-money"><span>৳</span><input id="pf-compareAt" inputMode="numeric" value={v.compareAt} onChange={(e) => set('compareAt', digitsOnly(e.target.value))} aria-invalid={Boolean(problems.compareAt)} /></div>
                {problems.compareAt && <span className="error-text small">{problems.compareAt}</span>}</div>
              <div className="field"><label htmlFor="pf-cat">{t('cat.category')}</label>
                <input id="pf-cat" list="pf-cats" value={v.category} onChange={(e) => set('category', e.target.value)} maxLength={40} />
                <datalist id="pf-cats">{extra.categories.map((c) => <option key={c} value={c} />)}</datalist></div>
            </div>
            <div className="field" style={{ maxWidth: 220 }}><label htmlFor="pf-code">{t('cat.code')}</label>
              <input id="pf-code" value={v.code} onChange={(e) => set('code', e.target.value)} maxLength={20} placeholder={t('cat.codeAuto')} /></div>
          </Card>

          <Photos t={t} v={v} set={set} />

          <Card title={t('cat.variants')} action={edit && (
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" disabled={v.options.length >= 3} onClick={() => setOptions([...v.options, { name: v.options.some((o) => /size/i.test(o.name)) ? 'Colour' : 'Size', values: [] }])}>+ {t('cat.option')}</Button>
              <Button size="sm" disabled={!v.variants.length} onClick={() => setBulk(true)}>{t('cat.bulk')}</Button>
            </div>
          )}>
            {v.options.length === 0 ? (
              <div className="pf-nostock">
                <p className="small muted">{t('cat.noOptions')}</p>
                <Toggle checked={v.inStock} onChange={(on) => set('inStock', on)} label={t('cat.inStockToggle')} />
              </div>
            ) : (
              <>
                {v.options.map((o, i) => <OptionRow key={i} t={t} o={o} onChange={(next) => setOptions(v.options.map((x, j) => (j === i ? next : x)).filter(Boolean))} />)}
                <VariantTable t={t} v={v} setVariants={(variants) => set('variants', variants)} />
                <p className="small muted">{t('cat.soldOutHint')}</p>
              </>
            )}
          </Card>

          <Card title={t('cat.sizeChart')} action={<Toggle checked={Boolean(v.sizeChartId)} disabled={!extra.sizeCharts.length} onChange={(on) => set('sizeChartId', on ? extra.sizeCharts[0]?.id ?? null : null)} label={t('cat.sizeChart')} />}>
            {extra.sizeCharts.length === 0 ? <p className="small muted">{t('cat.noCharts')}</p> : (
              <>
                <select value={v.sizeChartId ?? ''} className="input" onChange={(e) => set('sizeChartId', e.target.value ? Number(e.target.value) : null)} aria-label={t('cat.sizeChart')} style={{ maxWidth: 320 }}>
                  <option value="">{t('cat.noChart')}</option>
                  {extra.sizeCharts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <p className="small muted" style={{ marginTop: 8 }}>{t('cat.chartHint')}</p>
              </>
            )}
          </Card>
        </div>

        <div className="od-col">
          <Card title={t('cat.visibility')}>
            <div className="pf-vis" role="radiogroup" aria-label={t('cat.visibility')}>
              {VIS.map((k) => (
                <label key={k} className={`pf-vis-opt${v.visibility === k ? ' on' : ''}`}>
                  <input type="radio" name="vis" checked={v.visibility === k} onChange={() => set('visibility', k)} />
                  <span><strong>{t(`cat.visOpt.${k}`)}</strong><small>{t(`cat.visHint.${k}`)}</small></span>
                </label>
              ))}
            </div>
          </Card>

          {v.pageUrl && v.visibility === 'everywhere' && !v.archived && (
            <Card title={t('cat.page.title')}>
              <p className="small muted" style={{ marginTop: 0 }}>{t('cat.page.hint')}</p>
              <input className="input" readOnly value={v.pageUrl} aria-label={t('cat.page.title')} onFocus={(e) => e.target.select()} />
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <Button size="sm" onClick={() => navigator.clipboard?.writeText(v.pageUrl).then(() => toast(t('cat.page.copied'), 'green'))}>{t('cat.page.copy')}</Button>
                <a className="btn btn-default btn-sm" href={v.pageUrl} target="_blank" rel="noreferrer">{t('cat.page.open')}</a>
              </div>
            </Card>
          )}

          <Card title={<span className="row" style={{ gap: 8 }}><span className="pf-ai">AI</span>{t('cat.aiKnow')}</span>}>
            <textarea rows={3} className="input bn-ok" value={v.aiNotes} onChange={(e) => set('aiNotes', e.target.value)} maxLength={1000} placeholder={t('cat.aiPlaceholder')} aria-label={t('cat.aiKnow')} />
            <p className="small muted">{t('cat.aiHint')}</p>
            <Upsells t={t} v={v} id={id} known={extra.upsells} onChange={(ids, list) => { set('upsellIds', ids); setExtra((x) => ({ ...x, upsells: list })); }} />
          </Card>

          {id && <Posts t={t} id={id} posts={extra.posts} edit={edit} onChange={load} />}

          {id && extra.stats && (
            <Card>
              <div className="row">
                <span className="grow small muted">{t('cat.statsLine', { s: t.num(extra.stats.sold), r: t.num(extra.stats.returns) })}{extra.stats.lastOrderAt && ` · ${t('cat.lastOrder', { when: t.agoLong(extra.stats.lastOrderAt) })}`}</span>
                {edit && <Button size="sm" variant={v.archived ? 'default' : 'danger'} onClick={archive}>{v.archived ? t('cat.restore') : t('cat.archive')}</Button>}
              </div>
            </Card>
          )}
        </div>
      </fieldset>
      {bulk && <BulkEdit t={t} onClose={() => setBulk(false)} onApply={({ price, stock }) => {
        set('variants', v.variants.map((x) => ({ ...x, ...(price !== '' ? { price: Number(price) } : {}), ...(stock !== '' ? { stock: Number(stock) } : {}) })));
        setBulk(false);
      }} />}
    </div>
  );
}

function Photos({ t, v, set }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  async function add(e) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    setBusy(true);
    const urls = [];
    for (const f of files.slice(0, 10 - v.photos.length)) {
      if (f.size > 5 * 1024 * 1024) { toast(t('cat.photoBig', { name: f.name }), 'red'); continue; }
      try {
        const res = await fetch('/api/dash/uploads', { method: 'POST', headers: { 'content-type': f.type, 'x-file-name': encodeURIComponent(f.name), authorization: `Bearer ${session.token}` }, body: f });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        urls.push(d.url);
      } catch (err) { toast(err.message, 'red'); }
    }
    if (urls.length) set('photos', [...v.photos, ...urls]);
    setBusy(false);
  }
  return (
    <Card title={<span>{t('cat.photos')} <span className="small muted pf-sub">{t('cat.photosSub')}</span></span>}>
      <div className="pf-photos">
        {v.photos.map((url, i) => (
          <div key={url} className={`pf-photo${i === 0 ? ' cover' : ''}`}>
            <button type="button" className="pf-photo-btn" onClick={() => set('photos', [url, ...v.photos.filter((u) => u !== url)])} title={i ? t('cat.makeCover') : undefined} aria-label={i ? t('cat.makeCover') : t('cat.cover')}>
              <img src={url} alt="" />
            </button>
            {i === 0 && <span className="pf-cover">{t('cat.cover')}</span>}
            <button type="button" className="pf-photo-x" onClick={() => set('photos', v.photos.filter((u) => u !== url))} aria-label={t('cat.removePhoto')}><Icon name="x" size={12} /></button>
          </div>
        ))}
        {v.photos.length < 10 && (
          <button type="button" className="pf-photo-add" onClick={() => input.current?.click()} disabled={busy}>
            <Icon name="plus" size={18} /><span>{busy ? t('common.loading') : t('cat.addPhoto')}</span>
          </button>
        )}
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={add} />
      </div>
      {v.photos.length === 0 && <p className="small muted" style={{ marginTop: 8 }}>{t('cat.noPhotoHint')}</p>}
    </Card>
  );
}

function OptionRow({ t, o, onChange }) {
  const [val, setVal] = useState('');
  const addVals = () => {
    const vals = val.split(',').map((s) => s.trim()).filter(Boolean);
    if (vals.length) onChange({ ...o, values: [...new Set([...o.values, ...vals])].slice(0, 20) });
    setVal('');
  };
  return (
    <div className="pf-option">
      <input className="input input-sm pf-oname" value={o.name} onChange={(e) => onChange({ ...o, name: e.target.value })} aria-label={t('cat.optionName')} maxLength={20} />
      <div className="pf-values">
        {o.values.map((x) => (
          <span key={x} className="chip chip-sm">
            {isColour(o.name) && <span className="pf-dot" style={{ background: SWATCH[x.toLowerCase()] ?? 'var(--gray-soft)' }} />}{x}
            <button type="button" className="pf-x" onClick={() => onChange({ ...o, values: o.values.filter((y) => y !== x) })} aria-label={t('cat.removeValue', { v: x })}>×</button>
          </span>
        ))}
        <input className="input input-sm pf-addval" value={val} onChange={(e) => setVal(e.target.value)} onBlur={addVals}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addVals(); } }} placeholder={t('cat.addValue')} aria-label={t('cat.addValueFor', { o: o.name })} />
      </div>
      <button type="button" className="btn btn-link small" onClick={() => onChange(null)} aria-label={t('cat.removeOption', { o: o.name })}>×</button>
    </div>
  );
}

function VariantTable({ t, v, setVariants }) {
  const colourOpt = v.options.find((o) => isColour(o.name));
  const upd = (i, patch) => setVariants(v.variants.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  if (!v.variants.length) return <p className="small muted">{t('cat.addValuesFirst')}</p>;
  return (
    <div className="table-wrap pf-table">
      <table className="table">
        <thead><tr><th>{t('cat.variant')}</th><th>{t('cat.sku')}</th><th>{t('cat.price')}</th><th>{t('cat.stock')}</th></tr></thead>
        <tbody>
          {v.variants.map((x, i) => {
            const label = v.options.map((o) => x.options[o.name]).join(' / ');
            return (
              <tr key={keyOf(x.options, v.options)}>
                <td><span className="row" style={{ gap: 6 }}>{colourOpt && <span className="pf-dot" style={{ background: SWATCH[String(x.options[colourOpt.name]).toLowerCase()] ?? 'var(--gray-soft)' }} />}<strong>{label}</strong></span></td>
                <td><input className="input input-sm" value={x.sku} onChange={(e) => upd(i, { sku: e.target.value })} maxLength={40} aria-label={t('cat.skuFor', { v: label })} /></td>
                <td><div className="pf-money sm"><span>৳</span><input inputMode="numeric" value={x.price} onChange={(e) => upd(i, { price: e.target.value.replace(/\D/g, '') })} aria-label={t('cat.priceFor', { v: label })} /></div></td>
                <td>
                  <div className="pf-stepper">
                    <button type="button" onClick={() => upd(i, { stock: Math.max(0, (x.stock ?? 0) - 1) })} aria-label={t('cat.less', { v: label })}>−</button>
                    <input inputMode="numeric" value={x.stock ?? ''} placeholder="∞" onChange={(e) => upd(i, { stock: e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')) })} aria-label={t('cat.stockFor', { v: label })} />
                    <button type="button" onClick={() => upd(i, { stock: (x.stock ?? 0) + 1 })} aria-label={t('cat.more', { v: label })}>+</button>
                  </div>
                  {x.reserved > 0 && <small className="faint">{t('cat.reserved', { n: x.reserved })}</small>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BulkEdit({ t, onClose, onApply }) {
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  return (
    <Modal title={t('cat.bulk')} subtitle={t('cat.bulkSub')} onClose={onClose} width={420}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={price === '' && stock === ''} onClick={() => onApply({ price, stock })}>{t('cat.apply')}</Button></>}>
      <div className="of-two">
        <div className="field"><label htmlFor="bk-p">{t('cat.price')}</label><input id="bk-p" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} placeholder={t('cat.unchanged')} /></div>
        <div className="field"><label htmlFor="bk-s">{t('cat.stock')}</label><input id="bk-s" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value.replace(/\D/g, ''))} placeholder={t('cat.unchanged')} /></div>
      </div>
    </Modal>
  );
}

// "Upsell: Silk Orna — Gold" chips: products the AI suggests as an add-on.
function Upsells({ t, v, id, known, onChange }) {
  const [open, setOpen] = useState(false);
  const names = useMemo(() => new Map(known.map((k) => [k.id, k])), [known]);
  return (
    <div className="pf-upsells">
      {v.upsellIds.map((uid) => (
        <span key={uid} className="chip chip-sm">{t('cat.upsell', { name: names.get(uid)?.name ?? `#${uid}` })}
          <button type="button" className="pf-x" onClick={() => onChange(v.upsellIds.filter((x) => x !== uid), known)} aria-label={t('common.delete')}>×</button></span>
      ))}
      {v.upsellIds.length < 3 && <button type="button" className="chip chip-sm chip-add" onClick={() => setOpen(true)}>+ {t('cat.addUpsell')}</button>}
      {open && <Picker t={t} type="products" title={t('cat.addUpsell')} exclude={[id, ...v.upsellIds]} onClose={() => setOpen(false)}
        onPick={(p) => { onChange([...v.upsellIds, p.id], [...known, { id: p.id, name: p.name }]); setOpen(false); }} />}
    </div>
  );
}

function Posts({ t, id, posts, edit, onChange }) {
  const [open, setOpen] = useState(false);
  async function unlink(p) {
    try { await dash(`/catalog/products/${id}/posts/${p.id}`, { method: 'DELETE' }); onChange(); } catch (e) { toast(e.message, 'red'); }
  }
  async function link(p) {
    setOpen(false);
    try { await dash(`/catalog/products/${id}/posts/${p.id}`, { method: 'PUT' }); toast(t('cat.linked'), 'green'); onChange(); } catch (e) { toast(e.message, 'red'); }
  }
  return (
    <Card title={t('cat.posts')} action={<span className="muted">{t.num(posts.length)}</span>}>
      <p className="small muted">{t('cat.postsHint')}</p>
      <ul className="pf-posts">
        {posts.map((p) => (
          <li key={p.id} className="row">
            <span className="pf-post-img" style={{ background: p.image ? `center/cover url(${p.image})` : 'var(--accent-soft)' }} />
            <span className="grow"><strong className="bn-ok">{p.caption || t('cat.untitledPost')}</strong><small className="muted">{t('cat.postMeta', { n: t.num(p.comments), when: t.date(p.postedAt) })}</small></span>
            {edit && <button type="button" className="btn btn-sm" onClick={() => unlink(p)} aria-label={t('cat.unlink')}>×</button>}
          </li>
        ))}
      </ul>
      {edit && <Button className="pf-linkbtn" onClick={() => setOpen(true)}>+ {t('cat.linkPost')}</Button>}
      {open && <Picker t={t} type="posts" title={t('cat.linkPost')} exclude={posts.map((p) => p.id)} onClose={() => setOpen(false)} onPick={link} />}
    </Card>
  );
}

function Picker({ t, type, title, exclude, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  useEffect(() => {
    const timer = setTimeout(() => dash(`/catalog/pick?type=${type}&q=${encodeURIComponent(q)}`).then(setList).catch(() => setList([])), 200);
    return () => clearTimeout(timer);
  }, [q, type]);
  const shown = (list ?? []).filter((x) => !exclude.includes(x.id));
  return (
    <Modal title={title} onClose={onClose} width={460}>
      <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} />
      <ul className="pf-pick">
        {list === null ? <li><Skeleton h={40} /></li> : shown.length === 0 ? <li className="small muted">{type === 'posts' ? t('cat.noPosts') : t('cat.noMatch')}</li>
          : shown.map((x) => (
            <li key={x.id}><button type="button" onClick={() => onPick(x)}>
              {type === 'posts'
                ? <><strong className="bn-ok">{x.caption || t('cat.untitledPost')}</strong><small className="muted">{t('cat.postMeta', { n: t.num(x.comments), when: t.date(x.postedAt) })}</small></>
                : <><strong>{x.name}</strong><small className="muted">{x.code} · {t.money(x.price)}</small></>}
            </button></li>
          ))}
      </ul>
    </Modal>
  );
}

