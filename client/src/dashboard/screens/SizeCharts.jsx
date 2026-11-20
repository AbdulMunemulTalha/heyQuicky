import { useCallback, useEffect, useRef, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Empty, ErrorState, Pill, Segmented, Skeleton, toast } from '../ui/kit.jsx';
import './posts.css';
import './sizecharts.css';

// A sensible start for a new chart (kurti / shirt measurements in inches).
const TEMPLATE = { name: '', unit: 'inch', columns: ['Size', 'Chest', 'Length'], rows: [['S', '36', '40'], ['M', '38', '41'], ['L', '40', '42'], ['XL', '42', '43']], howTo: '', image: '', categories: [] };

// Phase 2 · Size charts (CAT-05), frame "Size charts": the charts, the one being edited, and the
// image the customer gets when they ask which size fits.
export default function SizeCharts({ query }) {
  const t = useT();
  const { can } = useDash();
  const selected = query.chart === 'new' ? 'new' : Number(query.chart) || null;
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash('/size-charts').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!selected && d?.charts[0]) setQuery({ chart: d.charts[0].id });
  }, [d, selected]);

  if (error) return <ErrorState thing={t('sc.title')} error={error} onRetry={load} />;
  const edit = can('edit_products');
  return (
    <div className="sizecharts">
      <button type="button" className="sc-back" onClick={() => navigate('/catalog')}>← {t('nav.catalog')}</button>
      <header className="page-head">
        <div><h1>{t('sc.title')}</h1><p className="page-sub">{t('sc.sub')}</p></div>
        <div className="page-actions">
          {d?.withoutChart > 0 && <Pill tone="yellow">{t('sc.withoutChart', { n: t.num(d.withoutChart) })}</Pill>}
          {edit && <Button variant="primary" onClick={() => setQuery({ chart: 'new' })}>{t('sc.new')}</Button>}
        </div>
      </header>
      <div className="sc-layout">
        <div className="card sc-listcard">
          {!d ? <Skeleton h={50} r={10} /> : d.charts.length === 0 && selected !== 'new' ? (
            <Empty icon="catalog" title={t('sc.empty')}>{t('sc.emptySub')}</Empty>
          ) : (
            <ul className="sc-list">
              {selected === 'new' && <li><button type="button" className="sc-row on"><strong>{t('sc.newChart')}</strong><small className="muted">{t('sg.unsaved')}</small></button></li>}
              {d.charts.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`sc-row${selected === c.id ? ' on' : ''}`} onClick={() => setQuery({ chart: c.id })} aria-current={selected === c.id}>
                    <strong className="bn-ok">{c.name}</strong>
                    <small className="muted">{t('sc.sizes', { n: t.num(c.rows.length) })} · {t('sc.productsN', { n: t.num(c.used) })}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected ? <Editor key={selected} t={t} id={selected} edit={edit} categories={d?.categories ?? []} onSaved={(id) => { load(); if (id) setQuery({ chart: id }); }} /> : null}
      </div>
    </div>
  );
}

// "Image the customer gets": the chart as it looks in the chat.
function ChartImage({ t, c, shop }) {
  return (
    <div className="sc-img">
      <div className="sc-imghead"><strong>{shop}</strong><small>{t('sc.chartUnit', { u: t(c.unit === 'cm' ? 'sc.cmCaps' : 'sc.inchCaps') })}</small></div>
      {c.image ? <img src={c.image} alt={c.name} /> : (
        <table>
          <thead><tr>{c.columns.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
          <tbody>{c.rows.map((r, i) => <tr key={i}>{r.map((v, j) => (j === 0 ? <th key={j} scope="row">{v}</th> : <td key={j}>{v}</td>))}</tr>)}</tbody>
        </table>
      )}
      {c.howTo && <small className="sc-imghow bn-ok">{c.howTo}</small>}
    </div>
  );
}

function Editor({ t, id, edit, categories, onSaved }) {
  const { me } = useDash();
  const isNew = id === 'new';
  const [c, setC] = useState(isNew ? TEMPLATE : null);
  const [saved, setSaved] = useState(isNew ? null : '');
  const [extra, setExtra] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [adding, setAdding] = useState(false);
  const fileRef = useRef(null);
  const load = useCallback(() => {
    if (isNew) return Promise.resolve();
    return dash(`/size-charts/${id}`).then((x) => { setC(x.chart); setSaved(JSON.stringify(x.chart)); setExtra(x); }, setError);
  }, [id, isNew]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!adding) return undefined;
    const timer = setTimeout(() => dash(`/catalog/pick?type=products&q=${encodeURIComponent(q)}`).then(setFound).catch(() => {}), 250);
    return () => clearTimeout(timer);
  }, [q, adding]);

  if (error) return <div className="card sc-editor"><ErrorState thing={t('sc.title')} error={error} onRetry={load} /></div>;
  if (!c) return <div className="card sc-editor"><Skeleton h={360} r={12} /></div>;
  const dirty = isNew || JSON.stringify(c) !== saved;
  const set = (patch) => setC((x) => ({ ...x, ...patch }));
  const cell = (ri, ci, v) => set({ rows: c.rows.map((r, i) => (i === ri ? r.map((x, j) => (j === ci ? v : x)) : r)) });
  const head = (ci, v) => set({ columns: c.columns.map((x, j) => (j === ci ? v : x)) });

  async function save() {
    setBusy(true);
    const body = { name: c.name, unit: c.unit, columns: c.columns, rows: c.rows, howTo: c.howTo, image: c.image, categories: c.categories };
    try {
      if (isNew) {
        const r = await dash('/size-charts', { method: 'POST', body });
        toast(r.assigned ? t('sc.createdAssigned', { n: t.num(r.assigned) }) : t('sc.created'), 'green');
        onSaved(r.id);
      } else {
        const r = await dash(`/size-charts/${id}`, { method: 'PATCH', body });
        toast(r.assigned ? t('sc.savedAssigned', { n: t.num(r.assigned) }) : t('common.saved'), 'green');
        await load(); onSaved();
      }
    } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('sc.deleteConfirm', { n: extra?.products.length ?? 0 }))) return;
    try { await dash(`/size-charts/${id}`, { method: 'DELETE' }); toast(t('sc.deleted')); setQuery({ chart: null }); onSaved(); } catch (err) { toast(err.message, 'red'); }
  }
  async function setProducts(ids) {
    try { await dash(`/size-charts/${id}/products`, { method: 'PUT', body: { productIds: ids } }); await load(); onSaved(); } catch (err) { toast(err.message, 'red'); }
  }
  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(file.type)) { toast(t('sc.badImage'), 'red'); return; }
    try {
      const res = await fetch('/api/dash/uploads', { method: 'POST', headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name), authorization: `Bearer ${session.token}` }, body: file });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      set({ image: r.url });
    } catch (err) { toast(err.message, 'red'); }
  }
  const productIds = extra?.products.map((p) => p.id) ?? [];
  // Products linked one by one, outside the chart's categories.
  const others = (extra?.products ?? []).filter((p) => !c.categories.includes(p.category));
  const counts = extra?.categoryCounts ?? {};
  const usage = extra?.usage;

  return (
    <>
      <div className="card sc-editor">
        <div className="sc-meta">
          <input className="input" value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('sc.namePlaceholder')} aria-label={t('sc.name')} maxLength={60} disabled={!edit} autoFocus={isNew} />
          <Segmented label={t('sc.unit')} value={c.unit} onChange={(v) => edit && set({ unit: v })} items={[{ key: 'inch', label: t('sc.inches') }, { key: 'cm', label: t('sc.centimetres') }]} />
        </div>
        {c.image ? (
          <div className="sc-hasimg">
            <img src={c.image} alt={c.name} />
            {edit && <Button size="sm" onClick={() => set({ image: '' })}>{t('sc.useTable')}</Button>}
          </div>
        ) : (
          <div className="sc-tablewrap">
            <table className="sc-table">
              <thead>
                <tr>
                  {c.columns.map((h, ci) => (
                    <th key={ci} scope="col">
                      <span className="sc-headcell">
                        <input value={h} onChange={(e) => head(ci, e.target.value)} aria-label={t('sc.columnN', { n: ci + 1 })} maxLength={24} disabled={!edit} />
                        {edit && ci > 0 && c.columns.length > 2 && <button type="button" className="sc-x" aria-label={t('sc.removeColumn', { c: h })} onClick={() => set({ columns: c.columns.filter((_, j) => j !== ci), rows: c.rows.map((r) => r.filter((_, j) => j !== ci)) })}>×</button>}
                      </span>
                    </th>
                  ))}
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {c.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((v, ci) => (
                      <td key={ci}>{ci === 0
                        ? <input className="sc-size" value={v} onChange={(e) => cell(ri, ci, e.target.value)} aria-label={t('sc.sizeN', { n: ri + 1 })} maxLength={16} disabled={!edit} />
                        : <input className="input" value={v} onChange={(e) => cell(ri, ci, e.target.value)} aria-label={`${c.columns[ci]} ${r[0]}`} maxLength={16} inputMode="decimal" disabled={!edit} />}</td>
                    ))}
                    <td className="sc-rowx">{edit && c.rows.length > 1 && <button type="button" className="sc-x" aria-label={t('sc.removeRow', { s: r[0] })} onClick={() => set({ rows: c.rows.filter((_, i) => i !== ri) })}>×</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {edit && (
          <div className="sc-tools">
            {!c.image && <Button size="sm" disabled={c.rows.length >= 12} onClick={() => set({ rows: [...c.rows, c.columns.map(() => '')] })}>{t('sc.addSize')}</Button>}
            {!c.image && <Button size="sm" disabled={c.columns.length >= 9} onClick={() => set({ columns: [...c.columns, ''], rows: c.rows.map((r) => [...r, '']) })}>{t('sc.addMeasurement')}</Button>}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={upload} />
            <Button size="sm" onClick={() => fileRef.current?.click()}>{t(c.image ? 'sc.replaceImage' : 'sc.uploadInstead')}</Button>
          </div>
        )}
        <label className="sc-label" htmlFor="sc-how">{t('sc.howToSent')}</label>
        <textarea id="sc-how" className="input" rows={2} value={c.howTo} onChange={(e) => set({ howTo: e.target.value })} placeholder={t('sc.howToPlaceholder')} maxLength={500} disabled={!edit} />

        <span className="sc-label">{t('sc.usedForTitle')}</span>
        <div className="sc-chips">
          {c.categories.map((k) => (
            <span key={k} className="sc-chip">{k}{counts[k] != null && ` · ${t('sc.productsN', { n: t.num(counts[k]) })}`}
              {edit && <button type="button" className="sc-chipx" aria-label={t('sc.removeCategory', { c: k })} onClick={() => set({ categories: c.categories.filter((x) => x !== k) })}>×</button>}</span>
          ))}
          {others.map((p) => (
            <span key={p.id} className="sc-chip prod">{p.name}
              {edit && <button type="button" className="sc-chipx" aria-label={t('sc.removeProduct', { p: p.name })} onClick={() => setProducts(productIds.filter((x) => x !== p.id))}>×</button>}</span>
          ))}
          {edit && categories.filter((k) => !c.categories.includes(k)).length > 0 && (
            <select className="sc-addchip" value="" onChange={(e) => e.target.value && set({ categories: [...c.categories, e.target.value] })} aria-label={t('sc.addCategory')}>
              <option value="">{t('sc.addCategoryShort')}</option>
              {categories.filter((k) => !c.categories.includes(k)).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
          {edit && !isNew && !adding && <button type="button" className="sc-addchip" onClick={() => setAdding(true)}>{t('sc.addProduct')}</button>}
        </div>
        {adding && (
          <div className="po-add sc-padd">
            <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('po.searchProducts')} aria-label={t('po.searchProducts')} autoFocus />
            <ul>{found.filter((x) => !productIds.includes(x.id)).slice(0, 8).map((x) => (
              <li key={x.id}><button type="button" onClick={() => { setProducts([...productIds, x.id]); setAdding(false); setQ(''); }}>{x.name}</button></li>
            ))}</ul>
          </div>
        )}
        <small className="faint">{t(dirty && c.categories.length ? 'sc.saveToApply' : 'sc.categoriesHint')}</small>

        {edit && (
          <div className="sc-foot">
            {!isNew && <button type="button" className="sc-del" onClick={remove}>{t('sc.deleteChart')}</button>}
            {dirty && <Button size="sm" variant="primary" busy={busy} disabled={!c.name.trim()} onClick={save}>{isNew ? t('sc.create') : t('common.save')}</Button>}
          </div>
        )}
      </div>

      <aside className="card sc-side">
        <small className="sc-sidetitle">{t('sc.image')}</small>
        <ChartImage t={t} c={c} shop={me?.workspace?.name ?? ''} />
        {!isNew && usage && (
          <small className="muted">{usage.month ? t('sc.askedMonth', { n: t.num(usage.month), when: t.ago(usage.lastAt) }) : t('sc.notAskedYet')}</small>
        )}
        {extra?.pageUrl && <a className="small sc-page" href={extra.pageUrl} target="_blank" rel="noreferrer">{t('sc.openPage')}</a>}
      </aside>
    </>
  );
}
