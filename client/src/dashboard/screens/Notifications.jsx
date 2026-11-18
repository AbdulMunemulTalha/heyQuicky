import { useCallback, useEffect, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Card, Empty, ErrorState, Skeleton, toast } from '../ui/kit.jsx';
import './notifications.css';

const TABS = ['all', 'orders', 'chats', 'system'];
const ICON = { handoff: 'chat', order: 'orders', escalation: 'alert', mention: 'chat', stock: 'box', credit: 'card', courier: 'truck' };
const TONE = { handoff: 'yellow', order: 'blue', escalation: 'red', mention: 'yellow', stock: 'orange', credit: 'gray', courier: 'gray' };
// The main action on each kind of alert (frame 16).
const ACTION = { handoff: 'nt.takeOver', order: 'nt.viewOrder', escalation: 'nt.review', stock: 'nt.restock', courier: 'nt.viewOrder', mention: 'nt.open', credit: 'nt.open' };
const NEW_FOR_MS = 24 * 3_600_000;

// Screen 16: the bell's panel. Opens over any screen; the gear switches to "Notify me about" (16b).
export default function NotificationsPanel({ onClose, view: startView = 'list' }) {
  const t = useT();
  const [view, setView] = useState(startView);
  const panel = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="nt-backdrop" onClick={onClose} aria-hidden />
      <section className="nt-panel" role="dialog" aria-modal="true" aria-label={t('shell.notifications')} ref={panel} tabIndex={-1}>
        {view === 'list' ? <List t={t} onClose={onClose} onSettings={() => setView('settings')} />
          : (
            <>
              <header className="nt-head"><button type="button" className="icon-btn" onClick={() => setView('list')} aria-label={t('common.back')}><Icon name="chevronLeft" size={16} /></button><h2 className="grow">{t('nt.notifyMe')}</h2></header>
              <div className="nt-scroll"><NotifySettings t={t} compact /></div>
            </>
          )}
      </section>
    </>
  );
}

function List({ t, onClose, onSettings }) {
  const { socket, me, refreshBadges } = useDash();
  const [tab, setTab] = useState('all');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash(`/notifications${tab === 'all' ? '' : `?category=${tab}`}`).then(setD, setError), [tab]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    const on = (n) => { if (n.userId === me.user.id) load(); };
    socket.on('notification', on);
    return () => socket.off('notification', on);
  }, [socket, me.user.id, load]);

  async function readAll() {
    try { await dash('/notifications/read-all', { method: 'POST' }); load(); refreshBadges(); } catch (e) { toast(e.message, 'red'); }
  }
  async function dismiss(n) {
    setD((x) => ({ ...x, items: x.items.filter((i) => i.id !== n.id), unread: x.unread - (n.read ? 0 : 1) }));
    try { await dash(`/notifications/${n.id}/dismiss`, { method: 'POST' }); refreshBadges(); } catch (e) { toast(e.message, 'red'); load(); }
  }
  async function open(n) {
    if (!n.read) dash(`/notifications/${n.id}/read`, { method: 'POST' }).then(refreshBadges).catch(() => {});
    if (n.type === 'handoff' && /^\/inbox\/\d+/.test(n.link)) {
      await dash(`/inbox/${n.link.split('/')[2]}/takeover`, { method: 'POST' }).catch(() => {});
    }
    if (n.link) navigate(n.link);
    onClose();
  }

  const now = Date.now();
  const fresh = (d?.items ?? []).filter((n) => !n.read || now - new Date(n.at) < NEW_FOR_MS);
  const earlier = (d?.items ?? []).filter((n) => !fresh.includes(n));
  return (
    <>
      <header className="nt-head">
        <h2 className="grow">{t('shell.notifications')} {d?.unread > 0 && <span className="small muted">{t('nt.new', { n: t.num(d.unread) })}</span>}</h2>
        <Button size="sm" onClick={readAll} disabled={!d?.unread}>{t('nt.markAll')}</Button>
        <button type="button" className="icon-btn" onClick={onSettings} aria-label={t('nt.notifyMe')}><Icon name="settings" size={15} /></button>
      </header>
      <div className="nt-tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(`nt.tab.${k}`)}{k !== 'all' && d?.byCategory?.[k] > 0 && <span className="nt-count">{t.num(d.byCategory[k])}</span>}
          </button>
        ))}
      </div>
      <div className="nt-scroll">
        {error ? <ErrorState thing={t('shell.notifications')} error={error} onRetry={load} />
          : !d ? <div style={{ padding: 16 }}><Skeleton h={60} /><Skeleton h={60} /></div>
          : d.items.length === 0 ? <Empty icon="bell" title={t('nt.emptyTitle')}>{t('nt.emptyBody')}</Empty>
          : (
            <>
              {fresh.length > 0 && <h3 className="nt-group">{t('nt.groupNew')}</h3>}
              {fresh.map((n) => <Item key={n.id} t={t} n={n} onOpen={open} onDismiss={dismiss} />)}
              {earlier.length > 0 && <h3 className="nt-group">{t('nt.groupEarlier')}</h3>}
              {earlier.map((n) => <Item key={n.id} t={t} n={n} onOpen={open} onDismiss={dismiss} />)}
            </>
          )}
      </div>
    </>
  );
}

function Item({ t, n, onOpen, onDismiss }) {
  return (
    <article className={`nt-item${n.read ? '' : ' unread'}`}>
      <span className={`nt-icon tone-${TONE[n.type] ?? 'gray'}`}><Icon name={ICON[n.type] ?? 'bell'} size={15} /></span>
      <div className="grow">
        <p className="bn-ok"><strong>{n.title}</strong> {n.body}</p>
        <small className="muted">{t.ago(n.at)}</small>
        {(n.link || !n.read) && (
          <div className="row nt-actions">
            {n.link && <Button size="sm" variant="dark" onClick={() => onOpen(n)}>{t(ACTION[n.type] ?? 'nt.open')}</Button>}
            <Button size="sm" onClick={() => onDismiss(n)}>{t('nt.dismiss')}</Button>
          </div>
        )}
      </div>
      {!n.read && <span className="nt-dot" aria-label={t('nt.unread')} />}
    </article>
  );
}

// 16b "Notify me about": events × App / Phone / WhatsApp, plus quiet hours. Also on Settings → Notifications.
export function NotifySettings({ t, compact = false }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dash('/notifications/prefs').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState thing={t('nt.notifyMe')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={300} />;

  async function set(key, ch, on) {
    setD((x) => ({ ...x, events: x.events.map((e) => (e.key === key ? { ...e, [ch]: on } : e)) }));
    try { await dash('/notifications/prefs', { method: 'PATCH', body: { events: { [key]: { [ch]: on } } } }); } catch (e) { toast(e.message, 'red'); load(); }
  }
  async function setQuiet(on) {
    setD((x) => ({ ...x, quiet: on }));
    try { await dash('/notifications/prefs', { method: 'PATCH', body: { quiet: on } }); } catch (e) { toast(e.message, 'red'); load(); }
  }
  async function enablePhone() {
    setBusy(true);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error(t('nt.pushUnsupported'));
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(t('nt.pushDenied'));
      const reg = await navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(d.push.publicKey) });
      const r = await dash('/notifications/push', { method: 'POST', body: sub.toJSON() });
      setD((x) => ({ ...x, push: { ...x.push, devices: r.devices } }));
      toast(t('nt.pushOn'), 'green');
    } catch (e) { toast(e.message, 'red'); } finally { setBusy(false); }
  }

  const table = (
    <>
      <table className="nt-prefs">
        <thead><tr><th>{t('nt.event')}</th><th>{t('nt.app')}</th><th>{t('nt.phone')}</th><th title={d.whatsapp ? undefined : t('nt.waSoon')}>{t('nt.whatsapp')}</th></tr></thead>
        <tbody>
          {d.events.map((e) => (
            <tr key={e.key}>
              <td><strong>{t(`nt.ev.${e.key}`)}</strong><small className="muted">{t(`nt.evHint.${e.key}`)}</small></td>
              {['app', 'phone', 'whatsapp'].map((ch) => (
                <td key={ch}><input type="checkbox" checked={e[ch]} onChange={(x) => set(e.key, ch, x.target.checked)} aria-label={`${t(`nt.ev.${e.key}`)} — ${t(`nt.${ch}`)}`} /></td>
              ))}
            </tr>
          ))}
          <tr className="nt-quiet">
            <td><strong>{t('nt.quiet')}</strong><small className="muted">{t('nt.quietHint')}</small></td>
            <td colSpan={3} className="r"><input type="checkbox" checked={d.quiet} onChange={(x) => setQuiet(x.target.checked)} aria-label={t('nt.quiet')} /></td>
          </tr>
        </tbody>
      </table>
      <div className="nt-phone">
        {!d.push.publicKey ? <p className="small muted">{t('nt.pushNotSetUp')}</p> : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="small grow">{d.push.devices ? t('nt.devices', { n: t.num(d.push.devices) }) : t('nt.noDevices')}</span>
            <Button size="sm" busy={busy} onClick={enablePhone}>{t('nt.enablePhone')}</Button>
            {d.push.devices > 0 && <Button size="sm" variant="ghost" onClick={() => dash('/notifications/push/test', { method: 'POST' }).then(() => toast(t('nt.testSent'), 'green'), (e) => toast(e.message, 'red'))}>{t('nt.sendTest')}</Button>}
          </div>
        )}
        {!d.whatsapp && <p className="small faint">{t('nt.waSoon')}</p>}
      </div>
    </>
  );
  return compact ? table : <Card title={t('nt.notifyMe')}>{table}</Card>;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Settings → Notifications page.
export function NotificationSettingsPage() {
  const t = useT();
  return (
    <div className="settings">
      <header className="page-head"><div><h1>{t('settingsNav.notifications')}</h1><p className="page-sub">{t('nt.pageSub')}</p></div></header>
      <div style={{ maxWidth: 760 }}><NotifySettings t={t} /></div>
    </div>
  );
}
