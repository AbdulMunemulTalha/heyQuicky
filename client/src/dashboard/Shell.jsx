import { useEffect, useState } from 'react';
import { Link, navigate, useLocation } from './lib/router.jsx';
import { useT } from './lib/i18n.js';
import { useDash } from './lib/context.js';
import { dash } from './lib/api.js';
import { Icon, BrandMark } from './ui/icons.jsx';
import { Avatar, Badge, toast } from './ui/kit.jsx';
import { canInstall, installApp, onInstallChange } from './lib/pwa.js';

// Main navigation (Sidebar frame). `module` hides an item when the shop switched that module off (UX-07).
const NAV = [
  { section: 'nav.work' },
  { key: 'overview', to: '/', icon: 'overview', label: 'nav.overview' },
  { key: 'inbox', to: '/inbox', icon: 'inbox', label: 'nav.inbox', badge: 'inbox', tone: 'yellow' },
  { key: 'orders', to: '/orders', icon: 'orders', label: 'nav.orders', badge: 'orders', tone: 'gray' },
  { key: 'payments', to: '/payments', icon: 'card', label: 'nav.payments', badge: 'payments', tone: 'yellow' },
  { key: 'tickets', to: '/tickets', icon: 'ticket', label: 'nav.tickets', badge: 'tickets', tone: 'red', module: 'tickets' },
  { key: 'customers', to: '/customers', icon: 'customers', label: 'nav.customers',
    sub: [{ to: '/customers', label: 'nav.allCustomers' }, { to: '/customers/segments', label: 'nav.segments' }] },
  { section: 'nav.grow' },
  { key: 'growth', to: '/growth', icon: 'growth', label: 'nav.growth', module: 'growth' },
  { key: 'coupons', to: '/coupons', icon: 'tag', label: 'nav.coupons' },
  { key: 'saved', to: '/saved-replies', icon: 'saved', label: 'nav.saved' },
  { section: 'nav.ai' },
  { key: 'agent', to: '/agent', icon: 'agent', label: 'nav.agent', badge: 'agent', tone: 'gray',
    sub: [{ to: '/agent', label: 'nav.agentHome' }, { to: '/agent/training', label: 'ag.training' }] },
  { key: 'catalog', to: '/catalog', icon: 'catalog', label: 'nav.catalog', module: 'catalog',
    sub: [{ to: '/catalog', label: 'nav.products' }, { to: '/catalog/posts', label: 'nav.posts' }, { to: '/catalog/size-charts', label: 'nav.sizeCharts' }] },
  { section: 'nav.insights' },
  { key: 'analytics', to: '/analytics', icon: 'analytics', label: 'nav.analytics' },
];

// Settings navigation, shown in the sidebar on settings pages.
export const SETTINGS_NAV = [
  { key: 'billing', to: '/settings', icon: 'card', label: 'settingsNav.billing' },
  { key: 'plan', to: '/settings/plan', icon: 'sparkle', label: 'settingsNav.plan' },
  { key: 'channels', to: '/settings/channels', icon: 'chat', label: 'settingsNav.channels' },
  { key: 'team', to: '/settings/team', icon: 'customers', label: 'settingsNav.team' },
  { key: 'payments', to: '/settings/payments', icon: 'card', label: 'settingsNav.payments', module: 'payments' },
  { key: 'courier', to: '/settings/courier', icon: 'truck', label: 'settingsNav.courier', module: 'courier' },
  { key: 'integrations', to: '/settings/integrations', icon: 'bolt', label: 'settingsNav.integrations' },
  { key: 'modules', to: '/settings/modules', icon: 'overview', label: 'settingsNav.modules' },
  { key: 'notifications', to: '/settings/notifications', icon: 'bell', label: 'settingsNav.notifications' },
  { key: 'audit', to: '/settings/audit', icon: 'info', label: 'settingsNav.audit' },
];

export function activeKey(path) {
  const first = path.split('/')[1] ?? '';
  const map = { '': 'overview', inbox: 'inbox', comments: 'inbox', orders: 'orders', tickets: 'tickets', customers: 'customers',
    growth: 'growth', coupons: 'coupons', content: 'growth', 'saved-replies': 'saved', agent: 'agent', catalog: 'catalog',
    analytics: 'analytics', payments: 'payments', bookings: 'customers', settings: 'settings', profile: 'profile' };
  return map[first] ?? '';
}

function aiStatus(t, ws) {
  const n = ws.channels.length;
  const channels = t(n === 1 ? 'shell.channel' : 'shell.channels', { n });
  if (ws.aiMode === 'auto') return { text: `${t('shell.aiLive')} · ${channels}`, cls: '' };
  if (ws.aiMode === 'suggest') return { text: `${t('shell.practiceMode')} · ${channels}`, cls: 'practice' };
  return { text: `${t('shell.aiOff')} · ${channels}`, cls: 'off' };
}

export function Sidebar({ open, onClose }) {
  const t = useT();
  const { me, badges, openOverlay, setMe } = useDash();
  const { path } = useLocation();
  const active = activeKey(path);
  const settings = path.startsWith('/settings');
  const ws = me.workspace;
  const status = aiStatus(t, ws);
  const creditPct = Math.min(100, Math.round((ws.credit / Math.max(ws.credit, 500)) * 100));
  const settingsKey = path === '/settings' ? 'billing' : path.split('/')[2];

  async function toggleDuty() {
    const onDuty = !me.user.onDuty;
    setMe((m) => ({ ...m, user: { ...m.user, onDuty } }));
    try {
      await dash('/duty', { method: 'POST', body: { onDuty } });
    } catch (err) {
      setMe((m) => ({ ...m, user: { ...m.user, onDuty: !onDuty } }));
      toast(err.message, 'red');
    }
  }

  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label={t('nav.menu')} onClick={(e) => { if (e.target.closest('a')) onClose?.(); }}>
      <Link to="/" className="logo"><BrandMark size={26} />heyquicky</Link>
      <button type="button" className="brand-switch" onClick={() => openOverlay('brands')} aria-label={t('shell.switchBrand')}>
        <Avatar name={ws.name} size={30} tone="peach" />
        <span className="grow brand-text">
          <span className="brand-name">{ws.name}</span><br />
          <span className={`brand-status ${status.cls}`}>{status.text}</span>
        </span>
        <Icon name="updown" size={15} className="muted" />
      </button>

      {settings ? (
        <nav className="nav" aria-label={t('nav.settings')}>
          <Link to="/" className="nav-back">← {t('settingsNav.back')}</Link>
          <div className="nav-section">{t('settingsNav.title')}</div>
          {SETTINGS_NAV.filter((n) => !n.module || ws.modules[n.module]).map((n) => (
            <Link key={n.key} to={n.to} className={`nav-item${settingsKey === n.key ? ' on' : ''}`} title={t(n.label)} aria-current={settingsKey === n.key ? 'page' : undefined}>
              <Icon name={n.icon} size={17} /><span className="nav-label">{t(n.label)}</span>
            </Link>
          ))}
        </nav>
      ) : (
        <nav className="nav" aria-label={t('nav.menu')}>
          {NAV.filter((n) => !n.module || ws.modules[n.module]).flatMap((n, i) => (n.section
            ? [<div key={n.section + i} className="nav-section">{t(n.section)}</div>]
            : [
              <Link key={n.key} to={n.to} className={`nav-item${active === n.key ? ' on' : ''}`} title={t(n.label)} aria-current={active === n.key ? 'page' : undefined}>
                <Icon name={n.icon} size={17} /><span className="nav-label">{t(n.label)}</span>
                {n.badge && <Badge count={badges[n.badge]} tone={n.tone} />}
              </Link>,
              ...(n.sub && active === n.key ? [
                <div key={`${n.key}-sub`} className="nav-sub">
                  {n.sub.map((x, j) => {
                    // The first sub-item is the section's own page; it is "on" unless a sibling page is open.
                    const on = j === 0 ? !n.sub.slice(1).some((y) => path.startsWith(y.to)) : path.startsWith(x.to);
                    return <Link key={x.to} to={x.to} className={`nav-subitem${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>{t(x.label)}{x.badge && <Badge count={badges[x.badge]} tone="yellow" />}</Link>;
                  })}
                </div>,
              ] : []),
            ]))}
        </nav>
      )}

      <div className="side-foot">
        <InstallButton t={t} />
        <div className="credit-card">
          <div className="row"><span>{t('shell.aiCredit')}</span>
            {me.can.includes('billing') && <Link to="/settings/plan">{t('shell.topUp')}</Link>}</div>
          <strong className="credit-amount">{t.money(ws.credit, 2)}</strong>
          <div className="meter" aria-hidden="true"><span style={{ width: `${creditPct}%` }} /></div>
          <small>{t('shell.repliesLeft', { n: t.num(ws.repliesLeft) })}</small>
        </div>
        <div className="side-settings">
          <Link to="/settings" className={`nav-item${active === 'settings' ? ' on' : ''}`}><Icon name="settings" size={17} /><span className="nav-label">{t('nav.settings')}</span></Link>
          <button type="button" className="icon-btn" aria-label={t('help.title')} onClick={() => openOverlay('help')}><Icon name="help" size={16} /></button>
        </div>
        <div className="row">
          <Link to="/profile" className="me-row" style={{ flex: 1 }}>
            <Avatar name={me.user.name} src={me.user.avatar} size={30} tone="dark" />
            <span>
              <span className="me-name" style={{ color: 'var(--text)' }}>{me.user.name}</span><br />
              <span className="me-role">{t(`role.${me.user.role}`)} · {t('shell.profileLink')}</span>
            </span>
          </Link>
          <button type="button" className={`pill ${me.user.onDuty ? 'pill-green' : 'pill-gray'}`} style={{ border: 0, cursor: 'pointer', height: 24 }}
            onClick={toggleDuty} aria-pressed={me.user.onDuty}>
            {me.user.onDuty ? t('shell.onDuty') : t('shell.offDuty')}
          </button>
        </div>
      </div>
    </aside>
  );
}

export function Topbar({ onMenu }) {
  const t = useT();
  const { me, setMe, badges, openOverlay, setLanguage } = useDash();
  const ws = me.workspace;
  const canSwitch = me.user.role === 'owner' || me.user.role === 'admin';
  const [busy, setBusy] = useState(false);

  async function setMode(mode) {
    if (mode === ws.aiMode || !canSwitch) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(t(mode === 'auto' ? 'shell.goLiveConfirm' : 'shell.practiceConfirm'))) return;
    setBusy(true);
    try {
      const { aiMode } = await dash('/ai-mode', { method: 'POST', body: { mode } });
      setMe((m) => ({ ...m, workspace: { ...m.workspace, aiMode } }));
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="topbar">
      <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label={t('nav.menu')}><Icon name="menu" /></button>
      <button type="button" className="search-trigger" onClick={() => openOverlay('search')} aria-label={t('shell.search')}>
        <Icon name="search" size={16} /><span>{t('shell.search')}</span><kbd>⌘K</kbd>
      </button>
      <div className="topbar-right">
        <div className="mode-switch hide-mobile" role="radiogroup" aria-label="AI">
          <button type="button" role="radio" aria-checked={ws.aiMode === 'auto'} className={ws.aiMode === 'auto' ? 'on' : ''} disabled={busy || !canSwitch} onClick={() => setMode('auto')}>
            <span className={`dot${ws.aiMode === 'auto' ? '' : ' gray'}`} />{t('shell.aiLive')}
          </button>
          <button type="button" role="radio" aria-checked={ws.aiMode !== 'auto'} className={ws.aiMode !== 'auto' ? 'on' : ''} disabled={busy || !canSwitch} onClick={() => setMode('suggest')}>
            {t('shell.practice')}
          </button>
        </div>
        <button type="button" className="btn hide-mobile" title={t('shell.testChat')} onClick={() => openOverlay('testChat')}><Icon name="chat" size={15} /><span className="btn-label">{t('shell.testChat')}</span></button>
        <button type="button" className={`btn hide-mobile${t.lang === 'en' ? ' bn' : ''}`} onClick={() => setLanguage(t.lang === 'en' ? 'bn' : 'en')} lang={t.lang === 'en' ? 'bn' : 'en'}>
          {t('shell.otherLang')}
        </button>
        <button type="button" className="icon-btn" onClick={() => openOverlay('notifications')} aria-label={`${t('shell.notifications')}${badges.alerts ? ` (${badges.alerts})` : ''}`}>
          <Icon name="bell" size={16} /><Badge count={badges.alerts} tone="yellow" />
        </button>
      </div>
    </header>
  );
}

// Bottom tabs on phones (frame 19): Inbox, Orders, Alerts, More.
export function MobileTabs({ onMore }) {
  const t = useT();
  const { badges, openOverlay } = useDash();
  const { path } = useLocation();
  const key = activeKey(path);
  return (
    <nav className="mobile-tabs" aria-label={t('nav.menu')}>
      <Link to="/inbox" className={key === 'inbox' ? 'on' : ''}><Icon name="chat" size={20} />{t('nav.inbox')}<Badge count={badges.inbox} /></Link>
      <Link to="/orders" className={key === 'orders' ? 'on' : ''}><Icon name="orders" size={20} />{t('nav.orders')}<Badge count={badges.orders} /></Link>
      <button type="button" onClick={() => openOverlay('notifications')}><Icon name="bell" size={20} />{t('nav.alerts')}<Badge count={badges.alerts} /></button>
      <button type="button" onClick={onMore}><Icon name="menu" size={20} />{t('nav.more')}</button>
    </nav>
  );
}

export { navigate };

// "Install the app" when the browser offers it (Android Chrome, desktop Chrome / Edge). iPhone uses Share → Add to Home Screen.
function InstallButton({ t }) {
  const [can, setCan] = useState(canInstall());
  useEffect(() => onInstallChange(setCan), []);
  if (!can) return null;
  return (
    <button type="button" className="install-btn" onClick={() => installApp().then((ok) => ok && toast(t('pwa.installed'), 'green'))}>
      <Icon name="bolt" size={15} /><span className="nav-label">{t('pwa.install')}</span>
    </button>
  );
}
