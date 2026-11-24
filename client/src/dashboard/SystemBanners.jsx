import { useContext } from 'react';
import { ConnectContext } from '../components/common.jsx';
import { useDash } from './lib/context.js';
import { navigate } from './lib/router.jsx';
import { Icon } from './ui/icons.jsx';
import { Button } from './ui/kit.jsx';
import { WhatsNewBar } from './screens/WhatsNew.jsx';

const COURIER = { steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX', paperfly: 'Paperfly', ecourier: 'eCourier' };

// Frame 17 "shown on every page": problems that stop the shop working, each with a one-click fix.
export function SystemBanners() {
  const { me, t, can } = useDash();
  const connect = useContext(ConnectContext);
  const ws = me.workspace;
  const owner = me.user.role === 'owner';
  const items = [];
  for (const c of ws.channels.filter((x) => x.needsReconnect)) {
    items.push({
      key: `ch${c.id}`, tone: 'red', icon: 'wifiOff',
      title: t(`state.reconnect.title.${c.platform}`, { name: c.name }), body: t('state.reconnect.body', { name: c.name }),
      action: owner && connect ? <Button size="sm" variant="danger-solid" onClick={() => connect.open(c.platform === 'messenger' ? 'facebook' : c.platform)}>{t('state.reconnect.cta')}</Button>
        : <span className="small">{t('state.reconnect.askOwner')}</span>,
    });
  }
  if (ws.creditEnforced && ws.credit <= 0) {
    items.push({
      key: 'credit', tone: 'yellow', icon: 'bolt', title: t('state.credit.title'), body: t('state.credit.body'),
      action: can('billing') ? <Button size="sm" variant="dark" onClick={() => navigate('/settings')}>{t('state.credit.cta')}</Button> : null,
    });
  }
  for (const key of ws.couriersNeedKeys ?? []) {
    items.push({
      key: `cr${key}`, tone: 'blue', icon: 'truck', title: t('state.courier.title', { c: COURIER[key] ?? key }), body: t('state.courier.body'),
      action: ['owner', 'admin'].includes(me.user.role) ? <Button size="sm" onClick={() => navigate('/settings/courier')}>{t('state.courier.cta')}</Button> : null,
    });
  }
  if (!items.length) return <WhatsNewBar />;
  return (
    <div className="sys-banners">
      <WhatsNewBar />
      {items.map((b) => (
        <div key={b.key} className={`sys-banner tone-${b.tone}`} role="alert">
          <span className="sys-icon"><Icon name={b.icon} size={15} /></span>
          <div className="grow"><strong>{b.title}</strong><span>{b.body}</span></div>
          {b.action}
        </div>
      ))}
    </div>
  );
}
