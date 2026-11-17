import { useEffect } from 'react';
import { dash } from '../lib/api.js';
import { greetingKey, useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Link, navigate } from '../lib/router.jsx';
import { Button, Card, ErrorState, Kpi, Pill, Skeleton, useLoad } from '../ui/kit.jsx';
import './overview.css';

const PLATFORM = { messenger: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp', web: 'Website' };

// Screen 01 (and 21 in Bangla, UX-02 in dark): today at a glance.
export default function Overview() {
  const t = useT();
  const { me, socket, openOverlay, can } = useDash();
  const { data, error, loading, reload } = useLoad(() => dash('/overview'), []);

  // New orders, chats and handoffs update the numbers without a refresh.
  useEffect(() => {
    if (!socket) return undefined;
    let timer;
    const soon = () => { clearTimeout(timer); timer = setTimeout(reload, 1500); };
    ['conversation', 'order', 'payment'].forEach((e) => socket.on(e, soon));
    return () => { clearTimeout(timer); ['conversation', 'order', 'payment'].forEach((e) => socket.off(e, soon)); };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = me.user.name.split(' ')[0];
  const k = data?.kpis;

  return (
    <div className="overview">
      <header className="page-head">
        <div>
          <h1>{t(greetingKey(), { name })}</h1>
          <p className="page-sub">
            {t.longDate()}{k && <> · {t('ov.handledLine', { n: k.aiHandled, total: k.conversations })}</>}
          </p>
        </div>
        <div className="page-actions">
          {can('edit_orders') && <Button icon="plus" onClick={() => navigate('/orders/new')}>{t('ov.newOrder')}</Button>}
          <Button onClick={() => navigate('/growth?tab=broadcasts')}>{t('ov.broadcast')}</Button>
          {can('teach_ai') && <Button variant="dark" onClick={() => navigate('/agent')}>{t('ov.teach')}</Button>}
        </div>
      </header>

      {error ? <ErrorState thing={t('nav.overview')} error={error} onRetry={reload} supportEmail={me.support.email} /> : (
        <>
          <div className="kpis ov-kpis">
            {loading && !data ? Array.from({ length: 5 }, (_, i) => <div className="kpi" key={i}><Skeleton w="50%" h={12} /><Skeleton w="40%" h={26} /><Skeleton w="70%" h={11} /></div>) : (
              <>
                <Kpi label={t('ov.kpi.conversations')} value={t.num(k.conversations)}
                  sub={k.conversationsChange === null ? t('ov.kpi.today') : <span className={k.conversationsChange >= 0 ? 'up' : ''}>{t('ov.kpi.vsYesterday', { n: `${k.conversationsChange >= 0 ? '+' : ''}${t.digits(k.conversationsChange)}%` })}</span>} />
                <Kpi label={t('ov.kpi.orders')} value={t.num(k.ordersToday)} sub={t('ov.kpi.ordersSub', { amount: t.money(k.revenueToday), n: k.ordersByAi })} onClick={() => navigate('/orders')} />
                <Kpi label={t('ov.kpi.ai')} value={t.pct(k.aiPct)}
                  sub={k.aiPctChange === null ? t('ov.kpi.aiSubNone') : <span className={k.aiPctChange >= 0 ? 'up' : ''}>{t('ov.kpi.aiSub', { n: `${k.aiPctChange >= 0 ? '+' : ''}${t.digits(k.aiPctChange)}` })}</span>} />
                <Kpi label={t('ov.kpi.firstReply')} value={duration(t, k.firstReplySec)} sub={k.teamFirstReplySec ? t('ov.kpi.teamAvg', { d: duration(t, k.teamFirstReplySec) }) : t('ov.kpi.noTeam')} />
                <Kpi tone="yellow" label={t('ov.kpi.needs')} value={t.num(k.needsPerson)} sub={t('ov.kpi.pastTarget', { n: k.pastTarget, m: k.slaMinutes })} onClick={() => navigate('/inbox?tab=waiting')} />
              </>
            )}
          </div>

          <div className="ov-grid">
            <div className="ov-col">
              <Card title={t('ov.attention')} action={<Link to="/inbox" className="small">{t('ov.openInbox')}</Link>} pad={false} className="ov-attention">
                {!data ? <div className="pad"><Skeleton h={40} /><br /><Skeleton h={40} /></div>
                  : data.attention.length ? <ul>{data.attention.map((a, i) => <AttentionRow key={i} a={a} />)}</ul>
                    : <p className="pad muted small">{t('ov.allClear')}</p>}
              </Card>

              <Card title={t('ov.week')} action={<span className="legend"><span className="dot blue" />{t('ov.byAi')}<span className="dot yellow" />{t('ov.byTeam')}</span>}>
                {data ? <WeekChart week={data.week} /> : <Skeleton h={180} />}
              </Card>

              <Card title={t('ov.pipeline')} action={<Link to="/orders" className="small">{t('ov.allOrders')}</Link>}>
                {data ? (
                  <div className="ov-pipeline">
                    {[
                      ['pending', 'yellow', '/orders?status=pending'],
                      ['approved', '', '/orders?status=approved'],
                      ['ready_to_ship', '', '/orders?status=ready_to_ship'],
                      ['in_transit', 'blue', '/orders?status=in_transit'],
                      ['delivered7', 'green', '/orders?status=delivered'],
                    ].map(([key, tone, to]) => (
                      <button key={key} type="button" className={`ov-stage ${tone}`} onClick={() => navigate(to)}>
                        <strong>{t.num(data.pipeline[key] + (key === 'pending' ? data.pipeline.on_hold : 0))}</strong>
                        <span>{t(`ov.stage.${key}`)}</span>
                      </button>
                    ))}
                  </div>
                ) : <Skeleton h={60} />}
              </Card>
            </div>

            <div className="ov-col">
              {data && <Checklist items={data.checklist} />}
              <Card title={t('ov.activity')}>
                {data ? (data.activity.length ? (
                  <ul className="ov-activity">
                    {data.activity.map((a, i) => (
                      <li key={i}><span className={`dot ${a.tone}`} />
                        <span><span className="bn-ok">{activityText(t, a)}</span><small>{t.agoLong(a.at)}</small></span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted small">{t('ov.noActivity')}</p>) : <Skeleton h={120} />}
              </Card>
              {data && (
                <Card title={t('ov.spend')}>
                  <dl className="ov-spend">
                    <div><dt>{t('ov.spend.ai', { n: data.spend.aiReplies })}</dt><dd>{t.money(data.spend.aiCost, 2)}</dd></div>
                    <div><dt>{t('ov.spend.saved', { n: data.spend.savedReplies })}</dt><dd className="ok-text">{t.money(0)} · {t('ov.spend.free')}</dd></div>
                    <div><dt>{t('ov.spend.roi')}</dt><dd>{data.spend.revenuePerTaka === null ? '—' : t.money(data.spend.revenuePerTaka)}</dd></div>
                  </dl>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
      <button type="button" className="sr-only" onClick={() => openOverlay('search')}>{t('shell.search')}</button>
    </div>
  );
}

function duration(t, sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return t('ov.sec', { n: Math.round(sec) });
  if (sec < 3600) return t('ov.min', { n: Math.round(sec / 60) });
  return t('ov.hour', { n: Math.round(sec / 3600) });
}

function AttentionRow({ a }) {
  const t = useT();
  const tag = {
    act_now: <Pill className="pill-act">{t('ov.tag.actNow')}</Pill>,
    handoff: <Pill tone="orange">{t('ov.tag.handoff')}</Pill>,
    payment: <Pill tone="blue">{t('ov.tag.payment')}</Pill>,
    risk: <Pill tone="red">{t('ov.tag.risk')}</Pill>,
    unanswered: <Pill tone="gray">{t('ov.tag.unanswered')}</Pill>,
  }[a.kind];
  let title;
  let sub;
  let action;
  if (a.kind === 'act_now' || a.kind === 'handoff') {
    title = a.kind === 'act_now' ? t('ov.att.actNow', { name: a.title }) : t('ov.att.handoff', { name: a.title });
    sub = [a.reason, PLATFORM[a.platform], a.since && t('ov.att.waiting', { d: t.ago(a.since) })].filter(Boolean).join(' · ');
    action = a.kind === 'act_now' ? t('ov.att.openChat') : t('ov.att.reply');
  } else if (a.kind === 'payment') {
    title = t('ov.att.payments', { n: a.count });
    sub = a.trx.join(' · ');
    action = t('ov.att.verify');
  } else if (a.kind === 'risk') {
    title = t('ov.att.risk', { n: a.number, name: a.name });
    sub = [a.reason, `COD ${t.money(a.cod)}`, a.area].filter(Boolean).join(' · ');
    action = t('ov.att.review');
  } else {
    title = t('ov.att.unanswered', { q: a.question, n: a.count });
    sub = t('ov.att.teachOnce');
    action = t('ov.att.teach');
  }
  return (
    <li className="ov-att">
      <span className="ov-tag">{tag}</span>
      <span className="grow"><strong>{title}</strong><small>{sub}</small></span>
      <button type="button" className="btn btn-sm" onClick={() => navigate(a.link)}>{action}</button>
    </li>
  );
}

function WeekChart({ week }) {
  const t = useT();
  const max = Math.max(1, ...week.map((d) => d.ai + d.team));
  return (
    <div className="ov-chart" role="img" aria-label={week.map((d) => `${t.date(d.day, { weekday: 'short' })}: ${d.ai + d.team}`).join(', ')}>
      {week.map((d) => {
        const sum = d.ai + d.team;
        return (
          <div className="ov-bar" key={d.day}>
            <span className="ov-bar-n">{t.num(sum)}</span>
            <div className="ov-bar-track">
              <span className="team" style={{ height: `${(d.team / max) * 100}%` }} />
              <span className="ai" style={{ height: `${(d.ai / max) * 100}%` }} />
            </div>
            <span className="ov-bar-day">{t.date(d.day, { weekday: 'short' })}</span>
          </div>
        );
      })}
    </div>
  );
}

function Checklist({ items }) {
  const t = useT();
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return null;
  return (
    <Card title={t('ov.checklist')} action={<span className="small ok-text">{t('ov.checkDone', { n: done, total: items.length })}</span>}>
      <div className="meter green" aria-hidden="true"><span style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <ul className="ov-check">
        {items.map((i) => (
          <li key={i.key} className={i.done ? 'done' : ''}>
            {t(`ov.check.${i.key}`, { n: i.count ?? 0 })}{i.optional && !i.done && ` (${t('common.optional')})`}
          </li>
        ))}
      </ul>
      <Button className="btn-block" onClick={() => navigate('/settings')}>{t('ov.finishSetup')}</Button>
    </Card>
  );
}

function activityText(t, a) {
  if (a.kind === 'order') return a.byAi ? t('ov.act.aiOrder', { n: a.number, name: a.name, amount: t.money(a.amount) }) : t('ov.act.order', { n: a.number, name: a.name, amount: t.money(a.amount) });
  return a.text;
}
