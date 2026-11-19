import { useCallback, useEffect, useRef, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { setQuery } from '../lib/router.jsx';
import { Button, Card, Empty, ErrorState, Pill, Segmented, Skeleton, toast } from '../ui/kit.jsx';
import { SizeChart } from '../ui/rich.jsx';
import '../ui/rich.css';
import './posts.css';
import './sizecharts.css';

// A sensible start for a new chart (kurti / shirt measurements in inches).
const TEMPLATE = { name: '', unit: 'inch', columns: ['Size', 'Chest', 'Length'], rows: [['S', '36', '40'], ['M', '38', '41'], ['L', '40', '42'], ['XL', '42', '43']], howTo: '', image: '', categories: [] };

// Phase 2 · Size charts (CAT-05): the chart the AI sends when a customer asks which size fits.
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
      <header className="page-head">
        <div><h1>{t('sc.title')}</h1><p className="page-sub">{t('sc.sub')}</p></div>
        <div className="page-actions">
          {d?.withoutChart > 0 && <Pill tone="yellow">{t('sc.withoutChart', { n: t.num(d.withoutChart) })}</Pill>}
          {edit && <Button variant="dark" onClick={() => setQuery({ chart: 'new' })}>{t('sc.new')}</Button>}
        </div>
      </header>
      <div className="sc-layout">
        <Card pad={false} className="sc-listcard">
          {!d ? <div style={{ padding: 16 }}><Skeleton h={50} r={10} /></div> : d.charts.length === 0 && selected !== 'new' ? (
            <Empty icon="catalog" title={t('sc.empty')} actions={edit && <Button variant="primary" onClick={() => setQuery({ chart: 'new' })}>{t('sc.new')}</Button>}>{t('sc.emptySub')}</Empty>
          ) : (
            <ul className="sc-list">
              {selected === 'new' && <li><button type="button" className="sc-row on"><strong>{t('sc.newChart')}</strong></button></li>}
              {d.charts.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`sc-row${selected === c.id ? ' on' : ''}`} onClick={() => setQuery({ chart: c.id })}>
                    <strong className="bn-ok">{c.name}</strong>
                    <small className="muted">{t('sc.sizes', { n: t.num(c.rows.length) })} · {t(c.unit === 'cm' ? 'sc.cm' : 'sc.inch')} · {t('sc.usedFor', { n: t.num(c.used) })}{c.image ? ` · ${t('sc.hasImage')}` : ''}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected ? <Editor key={selected} t={t} id={selected} edit={edit} categories={d?.categories ?? []} onSaved={(id) => { load(); if (id) setQuery({ chart: id }); }} /> : (
          <Card className="sc-none"><Empty icon="catalog" title={t('sc.pick')} /></Card>
        )}
      </div>
    </div>
  );
}

function Editor({ t, id, edit, categories, onSaved }) {
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

  if (error) return <Card className="sc-detail"><ErrorState thing={t('sc.title')} error={error} onRetry={load} /></Card>;
  if (!c) return <Card className="sc-detail"><Skeleton h={360} r={12} /></Card>;
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
  const preview = { name: c.name || t('sc.newChart'), productName: extra?.products[0]?.name ?? '', unit: c.unit, columns: c.columns, rows: c.rows, howTo: c.howTo, image: c.image, options: c.rows.map((r) => ({ title: r[0] })).filter((o) => o.title) };

  return (
    <div className="sc-detail">
      <Card title={isNew ? t('sc.newChart') : t('sc.chart')} action={(
        <div className="row" style={{ gap: 8 }}>
          {!isNew && edit && <Button size="sm" variant="ghost" onClick={remove}>{t('common.delete')}</Button>}
          {edit && <Button size="sm" variant="primary" busy={busy} disabled={!dirty || !c.name.trim()} onClick={save}>{isNew ? t('sc.create') : t('common.save')}</Button>}
        </div>
      )}>
        <div className="sc-meta">
          <input className="input" value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('sc.namePlaceholder')} aria-label={t('sc.name')} maxLength={60} disabled={!edit} autoFocus={isNew} />
          <Segmented label={t('sc.unit')} value={c.unit} onChange={(v) => edit && set({ unit: v })} items={[{ key: 'inch', label: t('sc.inch') }, { key: 'cm', label: t('sc.cm') }]} />
        </div>
        <div className="sc-tablewrap">
          <table className="sc-table">
            <thead>
              <tr>
                {c.columns.map((h, ci) => (
                  <th key={ci} scope="col">
                    <input className="input" value={h} onChange={(e) => head(ci, e.target.value)} aria-label={t('sc.columnN', { n: ci + 1 })} maxLength={24} disabled={!edit} />
                    {edit && ci > 0 && c.columns.length > 2 && <button type="button" className="sc-x" aria-label={t('sc.removeColumn', { c: h })} onClick={() => set({ columns: c.columns.filter((_, j) => j !== ci), rows: c.rows.map((r) => r.filter((_, j) => j !== ci)) })}>×</button>}
                  </th>
                ))}
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((v, ci) => (
                    <td key={ci}><input className={`input${ci === 0 ? ' sc-size' : ''}`} value={v} onChange={(e) => cell(ri, ci, e.target.value)} aria-label={`${c.columns[ci]} ${r[0]}`} maxLength={16} inputMode={ci === 0 ? 'text' : 'decimal'} disabled={!edit} /></td>
                  ))}
                  <td>{edit && c.rows.length > 1 && <button type="button" className="sc-x" aria-label={t('sc.removeRow', { s: r[0] })} onClick={() => set({ rows: c.rows.filter((_, i) => i !== ri) })}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {edit && (
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <Button size="sm" disabled={c.rows.length >= 12} onClick={() => set({ rows: [...c.rows, c.columns.map(() => '')] })}>{t('sc.addSize')}</Button>
            <Button size="sm" disabled={c.columns.length >= 9} onClick={() => set({ columns: [...c.columns, ''], rows: c.rows.map((r) => [...r, '']) })}>{t('sc.addMeasurement')}</Button>
          </div>
        )}
        <label className="small sc-label" htmlFor="sc-how"><strong>{t('sc.howTo')}</strong></label>
        <textarea id="sc-how" className="input" rows={3} value={c.howTo} onChange={(e) => set({ howTo: e.target.value })} placeholder={t('sc.howToPlaceholder')} maxLength={500} disabled={!edit} />
      </Card>

      <div className="sc-cols">
        <Card title={t('sc.image')}>
          <div className="sc-preview"><SizeChart t={t} c={preview} /></div>
          {edit && (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={upload} />
              <Button size="sm" onClick={() => fileRef.current?.click()}>{t(c.image ? 'sc.replaceImage' : 'sc.uploadImage')}</Button>
              {c.image && <Button size="sm" variant="ghost" onClick={() => set({ image: '' })}>{t('sc.useTable')}</Button>}
            </div>
          )}
          <small className="faint">{t(c.image ? 'sc.imageHint' : 'sc.tableHint')}</small>
          {extra?.pageUrl && <a className="small sc-page" href={extra.pageUrl} target="_blank" rel="noreferrer">{t('sc.openPage')}</a>}
        </Card>

        <Card title={t('sc.usedForTitle')}>
          {isNew ? <p className="small muted">{t('sc.saveFirst')}</p> : (
            <>
              {extra.products.length === 0 ? <p className="small muted">{t('sc.noProducts')}</p> : (
                <ul className="sc-products">
                  {extra.products.map((p) => (
                    <li key={p.id}><span className="grow bn-ok">{p.name}{p.category && <small className="muted"> · {p.category}</small>}</span>
                      {edit && <button type="button" className="sc-x" aria-label={t('sc.removeProduct', { p: p.name })} onClick={() => setProducts(productIds.filter((x) => x !== p.id))}>×</button>}</li>
                  ))}
                </ul>
              )}
              {edit && (adding ? (
                <div className="po-add">
                  <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('po.searchProducts')} aria-label={t('po.searchProducts')} autoFocus />
                  <ul>{found.filter((x) => !productIds.includes(x.id)).slice(0, 8).map((x) => (
                    <li key={x.id}><button type="button" onClick={() => { setProducts([...productIds, x.id]); setAdding(false); setQ(''); }}>{x.name}</button></li>
                  ))}</ul>
                </div>
              ) : <Button size="sm" onClick={() => setAdding(true)}>{t('sc.addProduct')}</Button>)}
            </>
          )}
          <div className="sc-cats">
            <strong className="small">{t('sc.categories')}</strong>
            <small className="muted">{t('sc.categoriesHint')}</small>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {c.categories.map((k) => <span key={k} className="chip on">{k}{edit && <button type="button" className="sc-chipx" aria-label={t('sc.removeCategory', { c: k })} onClick={() => set({ categories: c.categories.filter((x) => x !== k) })}>×</button>}</span>)}
              {edit && categories.filter((k) => !c.categories.includes(k)).length > 0 && (
                <select className="input sc-catpick" value="" onChange={(e) => e.target.value && set({ categories: [...c.categories, e.target.value] })} aria-label={t('sc.addCategory')}>
                  <option value="">{t('sc.addCategory')}</option>
                  {categories.filter((k) => !c.categories.includes(k)).map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              )}
            </div>
            {dirty && c.categories.length > 0 && <small className="faint">{t('sc.saveToApply')}</small>}
          </div>
        </Card>
      </div>
    </div>
  );
}
