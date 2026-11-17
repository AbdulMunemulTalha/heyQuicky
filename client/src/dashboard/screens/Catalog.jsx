import { useCallback, useEffect, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Link, navigate, setQuery, useLocation } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Empty, ErrorState, Kpi, Modal, PageHead, Pill, Skeleton, toast } from '../ui/kit.jsx';
import './catalog.css';

const FILTERS = ['all', 'in', 'low', 'out'];
const STATE_TONE = { in: 'green', low: 'yellow', out: 'gray' };

// Screen 08: everything the AI can show, price and sell (CAT-01/02).
export default function Catalog() {
  const t = useT();
  const { can } = useDash();
  const { query } = useLocation();
  const filter = query.filter || 'all';
  const [q, setQ] = useState(query.q || '');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [woo, setWoo] = useState(false);
  const load = useCallback(() => {
    const p = new URLSearchParams({ filter, ...(query.q ? { q: query.q } : {}) });
    return dash(`/catalog?${p}`).then(setD, setError);
  }, [filter, query.q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setTimeout(() => { if ((query.q || '') !== q.trim()) setQuery({ q: q.trim() || undefined }); }, 300);
    return () => clearTimeout(timer);
  }, [q, query.q]);

  if (error) return <ErrorState thing={t('nav.catalog')} error={error} onRetry={load} />;
  const edit = can('edit_products');
  const c = d?.counts;
  return (
    <div className="catalog">
      <PageHead title={t('nav.catalog')} sub={t('cat.sub')} actions={edit && (
        <>
          <Button onClick={() => setImporting(true)}>{t('cat.import')}</Button>
          <Button onClick={() => setWoo(true)}>{t('cat.woo')}</Button>
          <Button variant="primary" onClick={() => navigate('/catalog/new')}>+ {t('cat.add')}</Button>
        </>
      )} />

      <div className="cat-kpis">
        {c ? (
          <>
            <Kpi label={t('cat.k.products')} value={t.num(c.products)} onClick={() => setQuery({ filter: undefined })} />
            <Kpi label={t('cat.k.in')} value={t.num(c.in)} onClick={() => setQuery({ filter: 'in' })} />
            <Kpi label={t('cat.k.low')} value={<span className={c.low ? 'cat-low' : undefined}>{t.num(c.low)}</span>} onClick={() => setQuery({ filter: 'low' })} />
            <Kpi label={t('cat.k.out')} value={t.num(c.out)} onClick={() => setQuery({ filter: 'out' })} />
            <button type="button" className={`kpi cat-ready${d.readiness.count ? '' : ' ok'}`} onClick={() => setQuery({ filter: d.readiness.count ? 'needs' : undefined })}>
              <span className="kpi-label">{t('cat.readiness')}</span>
              <span className="cat-ready-text">{d.readiness.count ? t('cat.readyNeeds', { n: d.readiness.count }) : t('cat.readyAll')}</span>
            </button>
          </>
        ) : [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={92} r={12} />)}
      </div>

      <div className="cat-bar">
        <div className="chips" role="tablist" aria-label={t('cat.filter')}>
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setQuery({ filter: f === 'all' ? undefined : f })}>{t(`cat.f.${f}`)}</button>
          ))}
          {filter === 'needs' && <button type="button" role="tab" aria-selected className="chip on">{t('cat.f.needs')} ×</button>}
          {c?.archived > 0 && <button type="button" role="tab" aria-selected={filter === 'archived'} className={`chip${filter === 'archived' ? ' on' : ''}`} onClick={() => setQuery({ filter: 'archived' })}>{t('cat.f.archived', { n: c.archived })}</button>}
        </div>
        <input className="input input-sm cat-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cat.search')} aria-label={t('cat.search')} />
        <Link to="/catalog/size-charts" className="small">{t('cat.sizeCharts')}</Link>
      </div>

      {!d ? <div className="cat-grid">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} h={250} r={12} />)}</div>
        : d.products.length === 0 ? (
          c.products === 0 && filter === 'all' && !query.q
            ? <Empty icon="catalog" title={t('cat.emptyTitle')} actions={edit && <><Button variant="primary" onClick={() => navigate('/catalog/new')}>+ {t('cat.add')}</Button><Button onClick={() => setImporting(true)}>{t('cat.import')}</Button></>}>{t('cat.emptyBody')}</Empty>
            : <Empty icon="search" title={t('cat.noMatch')}>{t('cat.noMatchBody')}</Empty>
        ) : (
          <ul className="cat-grid">{d.products.map((p) => <ProductCard key={p.id} t={t} p={p} />)}</ul>
        )}
      {importing && <ImportDialog t={t} onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
      {woo && (
        <Modal title={t('cat.woo')} onClose={() => setWoo(false)} footer={<><Button onClick={() => setWoo(false)}>{t('common.close')}</Button><Button variant="primary" onClick={() => { setWoo(false); setImporting(true); }}>{t('cat.import')}</Button></>}>
          <p>{t('cat.wooSoon')}</p>
          <p className="small muted">{t('cat.wooHow')}</p>
        </Modal>
      )}
    </div>
  );
}

function ProductCard({ t, p }) {
  const sale = p.compareAt > p.price;
  let foot;
  if (p.archived) foot = t('cat.archivedNote');
  else if (p.state === 'out' && p.waiting) foot = t('cat.waiting', { n: p.waiting });
  else if (p.missing.includes('photo') && p.missing.includes('size_chart')) foot = t('cat.missingBoth');
  else if (p.missing.includes('size_chart')) foot = t('cat.missingChart');
  else if (p.missing.includes('photo')) foot = t('cat.missingPhoto');
  else if (p.posts) foot = t('cat.postsSold', { n: p.posts, s: p.sold });
  else foot = t('cat.sold', { n: p.sold });
  return (
    <li>
      <Link to={`/catalog/${p.id}`} className="cat-card">
        <div className="cat-photo" style={{ background: p.photo ? undefined : soft(p.colour) }}>
          {p.photo && <img src={p.photo} alt="" loading="lazy" />}
          <Pill tone={STATE_TONE[p.state]} className="cat-state">{t(`cat.state.${p.state}`)}{p.total !== null && ` · ${t.num(p.total)}`}</Pill>
          {sale && <span className="cat-sale">{t('cat.sale')}</span>}
          {p.visibility !== 'everywhere' && <span className="cat-vis">{t(`cat.vis.${p.visibility}`)}</span>}
        </div>
        <div className="cat-body">
          <div className="row cat-title"><strong className="grow bn-ok">{p.name}</strong><span className="faint small">{p.code}</span></div>
          <div className="cat-price"><strong>{t.money(p.price)}</strong>{sale && <s className="faint">{t.money(p.compareAt)}</s>}</div>
          {p.sizes.length > 0 && (
            <div className="cat-sizes">
              {p.sizes.map((s) => <span key={s.label} className={`cat-size${s.stock === 0 ? ' out' : ''}`}>{s.label}{s.stock !== null && <b> {t.num(s.stock)}</b>}</span>)}
              {p.moreSizes > 0 && <span className="cat-size">+{t.num(p.moreSizes)}</span>}
            </div>
          )}
          <p className={`cat-foot${p.missing.length && !p.archived ? ' warn' : ''}`}>{foot}</p>
        </div>
      </Link>
    </li>
  );
}

// The swatch behind products without a photo: a pale version of the product colour.
export function soft(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return 'var(--gray-soft)';
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.72);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function ImportDialog({ t, onClose, onDone }) {
  const [mode, setMode] = useState('csv');
  const [sheet, setSheet] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const file = useRef(null);
  async function run() {
    setBusy(true);
    setErr('');
    try {
      let body;
      if (mode === 'csv') {
        const f = file.current?.files?.[0];
        if (!f) throw new Error(t('cat.pickFile'));
        if (f.size > 2_000_000) throw new Error(t('cat.fileBig'));
        body = { csv: await f.text() };
      } else body = { sheetUrl: sheet.trim() };
      const r = await dash('/catalog/import', { method: 'POST', body });
      toast(t('cat.imported', { n: r.added, d: r.duplicates + r.skipped }), r.added ? 'green' : 'dark');
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={t('cat.import')} subtitle={t('cat.importSub')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} onClick={run}>{t('cat.importGo')}</Button></>}>
      <div className="chips" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'csv'} className={`chip${mode === 'csv' ? ' on' : ''}`} onClick={() => setMode('csv')}>{t('cat.csv')}</button>
        <button type="button" role="tab" aria-selected={mode === 'sheet'} className={`chip${mode === 'sheet' ? ' on' : ''}`} onClick={() => setMode('sheet')}>{t('cat.sheet')}</button>
      </div>
      <div style={{ marginTop: 12 }}>
        {mode === 'csv'
          ? <input ref={file} type="file" accept=".csv,text/csv" aria-label={t('cat.csv')} />
          : <input className="input" value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" aria-label={t('cat.sheet')} />}
        <p className="small muted" style={{ marginTop: 8 }}>{t('cat.importCols')}</p>
        {err && <p className="error-text small" role="alert">{err}</p>}
      </div>
      <p className="small faint"><Icon name="info" size={13} /> {t('cat.importSafe')}</p>
    </Modal>
  );
}
