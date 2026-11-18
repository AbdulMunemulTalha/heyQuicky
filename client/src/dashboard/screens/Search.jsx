import { useEffect, useMemo, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Avatar } from '../ui/kit.jsx';
import './search.css';

const FILTERS = ['all', 'chats', 'orders', 'customers', 'products'];

// Pages and actions for "Go to". `keys` is the G-then-letter shortcut (handled in Dashboard.jsx).
export const GO_TO = [
  { id: 'overview', label: 'nav.overview', to: '/', keys: 'H', icon: 'overview' },
  { id: 'inbox', label: 'nav.inbox', to: '/inbox', keys: 'I', icon: 'inbox' },
  { id: 'orders', label: 'nav.orders', to: '/orders', keys: 'O', icon: 'orders' },
  { id: 'newOrder', label: 'sr2.newOrder', to: '/orders/new', icon: 'plus', action: true },
  { id: 'customers', label: 'nav.customers', to: '/customers', keys: 'C', icon: 'customers' },
  { id: 'growth', label: 'nav.growth', to: '/growth', keys: 'F', icon: 'growth' },
  { id: 'saved', label: 'nav.saved', to: '/saved-replies', keys: 'S', icon: 'saved' },
  { id: 'agent', label: 'nav.agent', to: '/agent', keys: 'A', icon: 'agent' },
  { id: 'catalog', label: 'nav.catalog', to: '/catalog', keys: 'P', icon: 'catalog' },
  { id: 'newProduct', label: 'sr2.newProduct', to: '/catalog/new', icon: 'plus', action: true },
  { id: 'analytics', label: 'nav.analytics', to: '/analytics', keys: 'R', icon: 'analytics' },
  { id: 'settings', label: 'nav.settings', to: '/settings', keys: 'T', icon: 'settings' },
  { id: 'team', label: 'set.tab.team', to: '/settings/team', icon: 'customers' },
  { id: 'testChat', label: 'shell.testChat', overlay: 'testChat', icon: 'chat', action: true },
];

// Screen 23: universal search (⌘K, Ctrl+K or "/" from anywhere).
export default function SearchPalette({ onClose }) {
  const t = useT();
  const { openOverlay } = useDash();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setD(null); return undefined; }
    setBusy(true);
    const timer = setTimeout(() => {
      dash(`/search?q=${encodeURIComponent(query)}${filter === 'all' ? '' : `&type=${filter}`}`)
        .then((r) => { if (r.q === query) setD(r); }).catch(() => {}).finally(() => setBusy(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [q, filter]);

  const query = q.trim().toLowerCase();
  const pages = useMemo(() => GO_TO.filter((g) => !query || t(g.label).toLowerCase().includes(query)).slice(0, query ? 4 : GO_TO.length), [query, t]);

  // One flat list for the keyboard, grouped for display.
  const groups = [];
  if (d) {
    if (d.chats.length) groups.push({ key: 'chats', rows: d.chats.map((c) => ({ key: `c${c.id}`, go: `/inbox/${c.id}`, render: () => <ChatRow t={t} c={c} /> })) });
    if (d.orders.length) groups.push({ key: 'orders', rows: d.orders.map((o) => ({ key: `o${o.id}`, go: `/orders/${o.number}`, render: () => <OrderRow t={t} o={o} /> })) });
    if (d.customers.length) groups.push({ key: 'customers', rows: d.customers.map((c) => ({ key: `u${c.id}`, go: `/customers/${c.id}`, render: () => <CustomerRow t={t} c={c} /> })) });
    if (d.products.length) groups.push({ key: 'products', rows: d.products.map((p) => ({ key: `p${p.id}`, go: `/catalog/${p.id}`, render: () => <ProductRow t={t} p={p} /> })) });
  }
  if (filter === 'all' && pages.length) {
    groups.push({ key: 'goto', rows: pages.map((g) => ({ key: `g${g.id}`, go: g.to, overlay: g.overlay, render: () => <GoRow t={t} g={g} /> })) });
  }
  const flat = groups.flatMap((g) => g.rows);
  useEffect(() => { setActive(0); }, [q, filter, d]);
  useEffect(() => { listRef.current?.querySelector('.sp-row.on')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  function choose(row) {
    if (!row) return;
    onClose();
    if (row.overlay) setTimeout(() => openOverlay(row.overlay), 0);
    else navigate(row.go);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); } else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); } else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active]); } else if (e.key === 'Tab') {
      e.preventDefault();
      const i = FILTERS.indexOf(filter);
      setFilter(FILTERS[(i + (e.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length]);
    }
  }

  const nothing = d && query.length >= 2 && !groups.some((g) => g.key !== 'goto');
  let index = -1;
  return (
    <>
      <div className="sp-backdrop" onClick={onClose} aria-hidden />
      <div className="sp" role="dialog" aria-modal="true" aria-label={t('shell.search')} onKeyDown={onKey}>
        <div className="sp-input">
          <Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sr2.placeholder')} aria-label={t('shell.search')}
            role="combobox" aria-expanded="true" aria-controls="sp-list" aria-activedescendant={flat[active] ? `sp-${flat[active].key}` : undefined} />
          {busy && <span className="sp-spin" aria-hidden />}
          <kbd>Esc</kbd>
        </div>
        <div className="sp-filters" role="tablist" aria-label={t('sr2.filter')}>
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => { setFilter(f); input.current?.focus(); }}>{t(`sr2.f.${f}`)}</button>
          ))}
        </div>
        <div className="sp-list" id="sp-list" role="listbox" ref={listRef}>
          {query.length > 0 && query.length < 2 && <p className="sp-hint">{t('sr2.typeMore')}</p>}
          {nothing && <p className="sp-hint">{t('sr2.nothing', { q: q.trim() })}</p>}
          {groups.map((g) => (
            <section key={g.key}>
              <h3 className="sp-group">{t(`sr2.g.${g.key}`)}</h3>
              {g.rows.map((row) => {
                index += 1;
                const i = index;
                return (
                  <div key={row.key} id={`sp-${row.key}`} role="option" aria-selected={i === active} className={`sp-row${i === active ? ' on' : ''}`}
                    onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(row)}>
                    {row.render()}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <footer className="sp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('sr2.move')}</span>
          <span><kbd>Enter</kbd> {t('sr2.open')}</span>
          <span><kbd>/</kbd> {t('sr2.anywhere')}</span>
          <span className="grow" />
          <span>{t('sr2.inside')}</span>
        </footer>
      </div>
    </>
  );
}

function ChatRow({ t, c }) {
  return (
    <>
      <Avatar name={c.name} size={30} />
      <div className="grow"><strong>{c.name}</strong><small className="muted">{c.text}</small></div>
      <span className="sp-meta">{t.ago(c.at)}{c.platform && ` · ${t(`ag.ch.${c.platform}`)}`}</span>
    </>
  );
}

function OrderRow({ t, o }) {
  return (
    <>
      <span className="sp-icon">#</span>
      <div className="grow"><strong>#{t.digits(o.number)} · {o.name}</strong>
        <small className="muted bn-ok">{o.items}{o.more > 0 && ` +${t.num(o.more)}`} · {t.money(o.total)} · {t(`status.${o.status}`)}</small></div>
      <span className="sp-meta">{t.date(o.at)}</span>
    </>
  );
}

function CustomerRow({ t, c }) {
  return (
    <>
      <Avatar name={c.name} size={30} tone="green" />
      <div className="grow"><strong>{c.name}</strong>
        <small className="muted">{[c.phone, c.vip && 'VIP', t('sr2.orders', { n: t.num(c.orders) }), c.deliveredPct !== null && t('sr2.delivered', { p: t.pct(c.deliveredPct) })].filter(Boolean).join(' · ')}</small></div>
      {c.area && <span className="sp-meta">{c.area}</span>}
    </>
  );
}

function ProductRow({ t, p }) {
  return (
    <>
      <span className="sp-icon" style={p.photo ? { background: `center/cover url(${p.photo})` } : undefined}>{!p.photo && <Icon name="catalog" size={14} />}</span>
      <div className="grow"><strong>{p.name}</strong><small className="muted">{p.code} · {t.money(p.price)} · {p.inStock ? t('cat.state.in') : t('cat.state.out')}</small></div>
    </>
  );
}

function GoRow({ t, g }) {
  return (
    <>
      <span className="sp-icon"><Icon name={g.icon} size={14} /></span>
      <div className="grow"><strong>{t(g.label)}</strong><small className="muted">{g.action ? t('sr2.action') : t('sr2.openPage')}</small></div>
      {g.keys && <span className="sp-meta">{t('sr2.keys', { k: g.keys })}</span>}
    </>
  );
}
