import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Card, Chips, Empty, ErrorState, Pill, Segmented, Skeleton, Tabs, Toggle, toast } from '../ui/kit.jsx';
import './agent.css';

const TABS = ['unanswered', 'rules', 'versions'];
const CATEGORIES = ['tone', 'selling', 'never', 'handoff', 'other'];

// Phase 2 · Training (TRN-03/04/05/07): readiness and gaps, unanswered questions, rules, versions.
export default function Training({ query }) {
  const t = useT();
  const { can, socket, openOverlay } = useDash();
  const tab = TABS.includes(query.tab) ? query.tab : 'unanswered';
  const days = Number(query.days) || 14;
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash(`/training?days=${days}`).then(setD, setError), [days]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('unanswered', load);
    return () => socket.off('unanswered', load);
  }, [socket, load]);

  if (error) return <ErrorState thing={t('tr.title')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={420} r={12} />;
  const teach = can('teach_ai');
  const fix = (g) => {
    if (g.fix === 'knowledge') navigate('/agent');
    else if (g.fix === 'unanswered') setQuery({ tab: null });
    else navigate(g.fix);
  };

  return (
    <div className="training">
      <header className="page-head">
        <div><h1>{t('tr.title')}</h1><p className="page-sub">{t('tr.sub')}</p></div>
        <div className="page-actions">
          <Button onClick={() => openOverlay('testChat')}>{t('tr.openTest')}</Button>
          {teach && <Button variant="dark" onClick={() => navigate('/agent')}>{t('tr.addKnowledge')}</Button>}
        </div>
      </header>
      {!d.aiReady && <div className="alert-bar alert-yellow"><strong>{t('ag.notSetUp')}</strong> {t('tr.noAiPreview')}</div>}

      <div className="tr-top">
        <Card title={t('tr.readiness')} className="tr-ready">
          <div className="tr-score">
            <strong>{t.pct(d.readiness.score)}</strong>
            <span className="tr-bar" aria-hidden="true"><span style={{ width: `${d.readiness.score}%` }} className={d.readiness.score >= 80 ? 'good' : d.readiness.score >= 50 ? 'mid' : 'low'} /></span>
            <small className="muted">{t('tr.readinessSub', { done: d.readiness.checks.length - d.readiness.gaps.length, total: d.readiness.checks.length })}</small>
          </div>
        </Card>
        <Card title={t('tr.gaps')} action={<Pill tone={d.readiness.gaps.length ? 'yellow' : 'green'}>{t.num(d.readiness.gaps.length)}</Pill>} pad={false}>
          {d.readiness.gaps.length === 0 ? <Empty icon="check" tone="green" title={t('tr.noGaps')} /> : (
            <ul className="tr-gaps">
              {d.readiness.gaps.map((g) => (
                <li key={g.key}>
                  <span className="dot yellow" />
                  <div className="grow"><strong className="small">{t(`tr.gap.${g.key}`)}</strong><small className="muted">{t(`tr.gapHint.${g.key}`, { n: t.num(g.n ?? 0) })}</small></div>
                  <Button size="sm" onClick={() => fix(g)}>{t('tr.fix')}</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Tabs label={t('tr.title')} value={tab} onChange={(v) => setQuery({ tab: v === 'unanswered' ? null : v })} items={[
        { key: 'unanswered', label: t('tr.tab.unanswered'), count: d.unanswered.length },
        { key: 'rules', label: t('tr.tab.rules'), count: d.rules.filter((r) => r.enabled).length },
        { key: 'versions', label: t('tr.tab.versions') },
      ]} />
      {tab === 'unanswered' && <Unanswered t={t} d={d} days={days} teach={teach} openOverlay={openOverlay} onChange={load} />}
      {tab === 'rules' && <Rules t={t} d={d} teach={teach} onChange={load} />}
      {tab === 'versions' && <Versions t={t} d={d} teach={teach} onChange={load} />}
    </div>
  );
}

function Unanswered({ t, d, days, teach, openOverlay, onChange }) {
  async function ignore(u) {
    try { await dash(`/agent/unanswered/${u.id}/hide`, { method: 'POST' }); toast(t('tr.ignored')); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <Card pad={false} title={t('tr.unansweredTitle')} action={(
      <Segmented label={t('tr.period')} value={String(days)} onChange={(v) => setQuery({ days: v === '14' ? null : v })}
        items={['7', '14', '30'].map((n) => ({ key: n, label: t('tr.lastDays', { n: t.num(Number(n)) }) }))} />
    )}>
      {d.unanswered.length === 0 ? <Empty icon="check" tone="green" title={t('ag.allAnswered')}>{t('ag.allAnsweredSub')}</Empty> : (
        <ul className="tr-list">
          {d.unanswered.map((u) => (
            <li key={u.id}>
              <div className="grow">
                <p className="bn-ok tr-q">“{u.question}”</p>
                <small className="muted">{t('tr.askedTimes', { n: t.num(u.count) })} · {t.ago(u.lastAt)}</small>
              </div>
              {teach && <Button size="sm" variant="ghost" onClick={() => ignore(u)}>{t('tr.ignore')}</Button>}
              {teach && <Button size="sm" variant="primary" onClick={() => openOverlay('teach', { unanswered: u, onDone: onChange })}>{t('tr.teach')}</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Rules({ t, d, teach, onChange }) {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('tone');
  const [question, setQuestion] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  async function runPreview() {
    setBusy(true);
    try { setPreview(await dash('/training/rules/preview', { method: 'POST', body: { text, question } })); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function approve() {
    setBusy(true);
    try {
      const r = await dash('/training/rules', { method: 'POST', body: { text, category } });
      toast(t('tr.published', { n: r.version }), 'green');
      setText(''); setQuestion(''); setPreview(null); onChange();
    } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function patch(r, body) {
    try { const out = await dash(`/training/rules/${r.id}`, { method: 'PATCH', body }); toast(t('tr.published', { n: out.version }), 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  async function remove(r) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('tr.removeConfirm'))) return;
    try { const out = await dash(`/training/rules/${r.id}`, { method: 'DELETE' }); toast(t('tr.published', { n: out.version }), 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <div className="tr-rules">
      {teach && (
        <Card title={t('tr.newRule')}>
          <div className="tr-new">
          <div className="tr-form">
            <textarea className="input" rows={3} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder={t('tr.rulePlaceholder')} aria-label={t('tr.newRule')} maxLength={500} />
            <Chips label={t('tr.category')} value={category} onChange={setCategory} items={CATEGORIES.map((c) => ({ key: c, label: t(`tr.cat.${c}`) }))} />
            <input className="input" value={question} onChange={(e) => { setQuestion(e.target.value); setPreview(null); }} placeholder={t('tr.sampleQ')} aria-label={t('tr.sampleQ')} maxLength={300} />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={runPreview} busy={busy && !preview} disabled={!text.trim()}>{t('tr.preview')}</Button>
              <Button variant="primary" onClick={approve} busy={busy && Boolean(preview)} disabled={!text.trim() || !preview}>{t('tr.approve')}</Button>
            </div>
          </div>
          <div className="tr-phone" aria-live="polite">
            <span className="small muted">{t('tr.howSees')}</span>
            {preview ? (
              <>
                <div className="bubble cust bn-ok">{preview.question ?? question}</div>
                {preview.ai ? <div className="bubble shop bn-ok">{preview.reply}</div> : <small className="faint">{t('tr.noAiPreview')}</small>}
              </>
            ) : <small className="faint">{t('tr.previewFirst')}</small>}
          </div>
          </div>
        </Card>
      )}
      <Card title={t('tr.rulesTitle')} action={<Pill>{t.num(d.rules.filter((r) => r.enabled).length)}</Pill>} pad={false}>
        {d.rules.length === 0 ? <Empty icon="sparkle" title={t('tr.noRules')}>{t('tr.noRulesSub')}</Empty> : (
          <ul className="tr-list">
            {d.rules.map((r) => (
              <li key={r.id} className={r.enabled ? '' : 'off'}>
                <div className="grow">
                  <p className="bn-ok tr-q">{r.text}</p>
                  <small className="muted">{t(`tr.cat.${r.category}`, {})}{r.author && ` · ${r.author}`} · {t.ago(r.at)}</small>
                </div>
                <Toggle size="sm" checked={r.enabled} disabled={!teach} onChange={(on) => patch(r, { enabled: on })} label={t('tr.ruleOn')} />
                {teach && <Button size="sm" variant="ghost" onClick={() => remove(r)}>{t('common.delete')}</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Versions({ t, d, teach, onChange }) {
  async function rollback(v) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('tr.rollbackConfirm', { n: v.number }))) return;
    try { const r = await dash(`/training/versions/${v.number}/rollback`, { method: 'POST' }); toast(t('tr.rolledBack', { n: r.restored, v: r.version }), 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <Card pad={false} title={t('tr.versionsTitle')}>
      {d.versions.length === 0 ? <Empty icon="sparkle" title={t('tr.noVersions')} /> : (
        <ul className="tr-list">
          {d.versions.map((v) => (
            <li key={v.id}>
              <strong className="tr-vn">v{t.num(v.number)}</strong>
              <div className="grow">
                <p className="bn-ok tr-q">{v.summary}</p>
                <small className="muted">{v.by || '—'} · {t.agoLong(v.at)}</small>
              </div>
              {v.live ? <Pill tone="green">{t('tr.live')}</Pill> : teach && <Button size="sm" onClick={() => rollback(v)}>{t('tr.rollback')}</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
