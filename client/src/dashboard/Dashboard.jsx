import { Suspense, lazy, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { SocketContext } from '../components/common.jsx';
import { dash, setUnauthorizedHandler } from './lib/api.js';
import { I18n, makeT } from './lib/i18n.js';
import { Dash } from './lib/context.js';
import { match, useLocation } from './lib/router.jsx';
import { Sidebar, Topbar, MobileTabs } from './Shell.jsx';
import { Drawer, Empty, ErrorState, Skeleton, Toasts } from './ui/kit.jsx';
import './dashboard.css';

// Screens load on demand so the first paint stays small. Paths are under /app.
const screens = {
  overview: lazy(() => import('./screens/Overview.jsx')),
  inbox: lazy(() => import('./screens/Inbox.jsx')),
  comments: lazy(() => import('./screens/Comments.jsx')),
  orders: lazy(() => import('./screens/Orders.jsx')),
  orderDetail: lazy(() => import('./screens/OrderDetail.jsx')),
  orderForm: lazy(() => import('./screens/OrderForm.jsx')),
  customers: lazy(() => import('./screens/Customers.jsx')),
  growth: lazy(() => import('./screens/Growth.jsx')),
  saved: lazy(() => import('./screens/SavedReplies.jsx')),
  agent: lazy(() => import('./screens/Agent.jsx')),
  placeholder: lazy(() => import('./screens/Placeholder.jsx')),
};
const overlays = {
  testChat: lazy(() => import('./screens/TestChat.jsx')),
};

const ROUTES = [
  ['/', 'overview'],
  ['/inbox', 'inbox', { flush: true }],
  ['/inbox/:id', 'inbox', { flush: true }],
  ['/comments', 'comments', { flush: true }],
  ['/comments/:postId', 'comments', { flush: true }],
  ['/orders', 'orders'],
  ['/orders/new', 'orderForm'],
  ['/orders/:n/edit', 'orderForm'],
  ['/orders/:n', 'orderDetail'],
  ['/customers', 'customers'],
  ['/customers/:id', 'customers'],
  ['/growth', 'growth'],
  ['/saved-replies', 'saved'],
  ['/agent', 'agent'],
];

function pick(path) {
  for (const [pattern, key, opts] of ROUTES) {
    const params = match(pattern, path);
    if (params) return { key, params, flush: Boolean(opts?.flush) };
  }
  return { key: 'placeholder', params: {} };
}

const LANG_KEY = 'quicky:lang';

export function Dashboard({ onSignOut }) {
  const socket = useContext(SocketContext);
  const { path, query } = useLocation();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [lang, setLang] = useState(() => localStorage.getItem(LANG_KEY) || 'en');
  const [overlay, setOverlay] = useState(null); // { name, props }
  const [menuOpen, setMenuOpen] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);

  const load = useCallback(async () => {
    try {
      const data = await dash('/me');
      setMe(data);
      setError(null);
      if (!localStorage.getItem(LANG_KEY)) setLang(data.user.language);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(onSignOut);
    load();
    dash('/auth/ping', { method: 'POST' }).catch(() => {});
  }, [load, onSignOut]);

  const refreshBadges = useCallback(() => {
    dash('/badges').then((badges) => setMe((m) => (m ? { ...m, badges } : m))).catch(() => {});
  }, []);

  // Live updates: badge counts follow new chats, orders and notifications without a refresh.
  useEffect(() => {
    if (!socket) return undefined;
    const events = ['conversation', 'order', 'notification', 'unanswered'];
    events.forEach((e) => socket.on(e, refreshBadges));
    const onWorkspace = (patch) => setMe((m) => (m ? { ...m, workspace: { ...m.workspace, ...patch } } : m));
    socket.on('workspace', onWorkspace);
    return () => { events.forEach((e) => socket.off(e, refreshBadges)); socket.off('workspace', onWorkspace); };
  }, [socket, refreshBadges]);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // ⌘K / Ctrl+K and "/" open universal search (INB-05, UX-06).
  useEffect(() => {
    const onKey = (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOverlay({ name: 'search', props: {} });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const t = useMemo(() => makeT(lang), [lang]);

  const setLanguage = useCallback((next) => {
    setLang(next);
    localStorage.setItem(LANG_KEY, next);
    dash('/prefs', { method: 'PATCH', body: { language: next } }).catch(() => {});
  }, []);

  const theme = me?.user.theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : me?.user.theme ?? 'light';

  const ctx = useMemo(() => me && ({
    me, setMe, t, socket, query, reload: load, refreshBadges,
    badges: me.badges,
    can: (action) => me.can.includes(action),
    openOverlay: (name, props = {}) => setOverlay({ name, props }),
    closeOverlay: () => setOverlay(null),
    setLanguage,
    signOut: onSignOut,
  }), [me, t, socket, query, load, refreshBadges, setLanguage, onSignOut]);

  if (!me) {
    return (
      <div id="dash" lang={lang}>
        {error ? <div style={{ paddingTop: 80 }}><I18n.Provider value={t}><ErrorState thing="The dashboard" error={error} onRetry={load} /></I18n.Provider></div>
          : <div className="shell"><div className="sidebar" /><div className="content" style={{ paddingTop: 80 }}><Skeleton w="40%" h={28} /><br /><Skeleton h={120} r={12} /></div></div>}
      </div>
    );
  }

  const { key, params, flush } = pick(path);
  const Screen = screens[key];
  const Overlay = overlay && overlays[overlay.name];

  return (
    <I18n.Provider value={t}>
      <Dash.Provider value={ctx}>
        <div id="dash" lang={lang} data-theme={theme}>
          <a href="#main" className="skip">{t('shell.skip')}</a>
          {offline && <div className="offline-bar" role="status"><span className="dot yellow" />{t('state.offline.bar')}
            <button type="button" onClick={() => window.location.reload()}>{t('state.offline.retry')}</button></div>}
          <div className="shell">
            <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
            <div className="main">
              <Topbar onMenu={() => setMenuOpen(true)} />
              <main id="main" className={`content${flush ? ' flush' : ''}`} tabIndex={-1}>
                <Suspense fallback={<div><Skeleton w="30%" h={28} /><br /><Skeleton h={160} r={12} /></div>}>
                  <Screen params={params} query={query} path={path} />
                </Suspense>
              </main>
            </div>
          </div>
          <MobileTabs onMore={() => setMenuOpen(true)} />
          {menuOpen && <div className="drawer-backdrop" style={{ zIndex: 65 }} onClick={() => setMenuOpen(false)} />}
          {overlay && (Overlay
            ? <Suspense fallback={null}><Overlay {...overlay.props} onClose={() => setOverlay(null)} /></Suspense>
            : <Drawer title={t(`overlay.${overlay.name}`)} onClose={() => setOverlay(null)}><Empty icon="sparkle" title={t('state.comingSoon')} /></Drawer>)}
          <Toasts />
        </div>
      </Dash.Provider>
    </I18n.Provider>
  );
}

export { screens, overlays, ROUTES };
