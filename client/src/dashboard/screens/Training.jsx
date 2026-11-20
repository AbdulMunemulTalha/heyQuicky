import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Button, Card, Empty, ErrorState, Pill, Skeleton, Tabs, Toggle, toast } from '../ui/kit.jsx';
import './agent.css';

const TABS = ['unanswered', 'rules', 'versions'];
const CAT_TONE = { price: 'blue', handoff: 'yellow', tone: 'green', delivery: 'gray', safety: 'red', selling: 'purple', never: 'red', other: 'gray' };
// Gaps that stop the AI from selling are red; the rest are yellow.
const URGENT = ['products', 'prices', 'delivery', 'payment', 'policy'];
const gapAction = (g) => (g.key === 'unanswered' ? 'teach' : ['products', 'prices', 'sizeCharts', 'knowledge', 'saved'].includes(g.key) ? 'add' : 'fix');

// The readiness score as a ring.
function Ring({ value }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const tone = value >= 80 ? 'good' : value >= 50 ? 'mid' : 'low';
  return (
    <svg className={`tr-ring ${tone}`} viewBox="0 0 84 84" width="84" height="84" aria-hidden="true">
      <circle cx="42" cy="42" r={r} className="track" />
      <circle cx="42" cy="42" r={r} className="arc" strokeDasharray={`${(c * value) / 100} ${c}`} transform="rotate(-90 42 42)" />
    </svg>
  );
}

// Phase 2 · Training (TRN-03/04/05/07), frames "Training — readiness / rules / versions".
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
  const r = d.readiness;
  const target = 95;
  return (
    <div className="training">
      <button type="button" className="tr-back" onClick={() => navigate('/agent')}>← {t('nav.agent')}</button>
      <header className="page-head">
        <div><h1>{t('tr.title')}</h1><p className="page-sub">{t('tr.sub')}</p></div>
        <div className="page-actions">
          <Button onClick={() => openOverlay('testChat')}>{t('tr.openTest')}</Button>
          {teach && <Button variant="primary" onClick={() => navigate('/agent')}>{t('tr.addKnowledge')}</Button>}
        </div>
      </header>
      {!d.aiReady && <div className="alert-bar alert-yellow"><strong>{t('ag.notSetUp')}</strong> {t('tr.noAiPreview')}</div>}

      <div className="tr-top">
        <div className="card tr-ready">
          <div className="tr-ringwrap">
            <Ring value={r.score} />
            <strong className="tr-pct">{t.pct(r.score)}</strong>
          </div>
          <div className="tr-readytext">
            <strong>{t('tr.readiness')}</strong>
            <small className="muted">{r.gaps.length && r.score < target ? t('tr.fixToReach', { n: t.num(r.gaps.length), p: t.pct(target) }) : t('tr.readyGreat')}</small>
            {r.weekChange != null && r.weekChange !== 0 && <Pill tone={r.weekChange > 0 ? 'green' : 'red'}>{t('tr.weekChange', { n: `${r.weekChange > 0 ? '+' : '−'}${t.pct(Math.abs(r.weekChange))}` })}</Pill>}
          </div>
        </div>
        <div className="card tr-gapcard">
          <div className="tr-gaphead"><h3>{t('tr.gaps')}</h3><small className="muted">{t.num(r.gaps.length)}</small></div>
          {r.gaps.length === 0 ? <p className="small muted">{t('tr.noGaps')}</p> : (
            <ul className="tr-gaps">
              {r.gaps.map((g) => (
                <li key={g.key} title={t(`tr.gapHint.${g.key}`, { n: t.num(g.n ?? 0) })}>
                  <span className={`dot ${URGENT.includes(g.key) ? 'red' : 'yellow'}`} />
                  <span className="grow small bn-ok">{t(`tr.gapLine.${g.key}`, { n: t.num(g.n ?? 0) })}</span>
                  <Button size="sm" onClick={() => fix(g)}>{t(`tr.act.${gapAction(g)}`)}</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card card-flush tr-tabs">
        <div className="tr-tabbar">
          <Tabs label={t('tr.title')} value={tab} onChange={(v) => setQuery({ tab: v === 'unanswered' ? null : v })} items={[
            { key: 'unanswered', label: t('tr.tab.unanswered'), count: d.unanswered.length },
            { key: 'rules', label: t('tr.tab.rules'), count: d.rules.filter((x) => x.enabled).length },
            { key: 'versions', label: t('tr.tab.versions'), count: d.versions[0]?.number },
          ]} />
        </div>
        {tab === 'unanswered' && <Unanswered t={t} d={d} days={days} teach={teach} openOverlay={openOverlay} onChange={load} />}
        {tab === 'rules' && <Rules t={t} d={d} teach={teach} onChange={load} />}
        {tab === 'versions' && <Versions t={t} d={d} teach={teach} onChange={load} />}
      </div>
    </div>
  );
}

function Unanswered({ t, d, days, teach, openOverlay, onChange }) {
  async function ignore(u) {
    try { await dash(`/agent/unanswered/${u.id}/hide`, { method: 'POST' }); toast(t('tr.ignored')); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  const max = Math.max(1, ...d.unanswered.map((u) => u.count));
  return (
    <>
      <div className="tr-subbar">
        <small className="muted">{t('tr.unansweredHint')}</small>
        <select className="input input-sm" value={String(days)} onChange={(e) => setQuery({ days: e.target.value === '14' ? null : e.target.value })} aria-label={t('tr.period')}>
          {['7', '14', '30'].map((n) => <option key={n} value={n}>{t('tr.lastDays', { n: t.num(Number(n)) })}</option>)}
        </select>
      </div>
      {d.unanswered.length === 0 ? <Empty icon="check" tone="green" title={t('ag.allAnswered')}>{t('ag.allAnsweredSub')}</Empty> : (
        <div className="tr-tablewrap">
          <table className="tr-table">
            <thead><tr><th scope="col">{t('tr.colQuestion')}</th><th scope="col">{t('tr.colAsked')}</th><th scope="col">{t('tr.colLast')}</th><th scope="col"><span className="sr-only">{t('cp.actions')}</span></th></tr></thead>
            <tbody>
              {d.unanswered.map((u) => (
                <tr key={u.id}>
                  <td><span className="tr-qcell"><strong className="bn-ok">{u.question}</strong><small className="muted">{t(`tr.topic.${u.topic ?? 'other'}`)}</small></span></td>
                  <td><span className="tr-asked"><span className="tr-mini" aria-hidden="true"><span style={{ width: `${(u.count / max) * 100}%` }} /></span><strong>{t.num(u.count)}</strong></span></td>
                  <td className="muted">{t.ago(u.lastAt)}</td>
                  <td className="tr-actions">
                    {teach && <Button size="sm" onClick={() => ignore(u)}>{t('tr.ignore')}</Button>}
                    {teach && <Button size="sm" variant="primary" onClick={() => openOverlay('teach', { unanswered: u, onDone: onChange })}>{t('tr.teach')}</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Rules (frame "Training — rules"): write an instruction, "Preview & approve" shows how the customer
// sees it on the right, then it is published. The category is picked from its words.
function Rules({ t, d, teach, onChange }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  async function runPreview() {
    setBusy(true);
    try { setPreview(await dash('/training/rules/preview', { method: 'POST', body: { text } })); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function approve() {
    setBusy(true);
    try {
      const r = await dash('/training/rules', { method: 'POST', body: { text, category: preview?.category } });
      toast(t('tr.published', { n: r.version }), 'green');
      setText(''); setPreview(null); onChange();
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
  const on = d.rules.filter((r) => r.enabled).length;
  return (
    <div className="tr-rules">
      <div className="tr-rulesmain">
        {teach && (
          <div className="tr-new">
            <label className="tr-label" htmlFor="tr-rule">{t('tr.newInstruction')}</label>
            <textarea id="tr-rule" className="input" rows={2} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder={t('tr.rulePlaceholder')} maxLength={500} />
            <div className="tr-newfoot">
              <small className="muted">{t('tr.plainLanguage')}</small>
              {preview
                ? <span className="row" style={{ gap: 6 }}><Button size="sm" onClick={() => setPreview(null)}>{t('common.edit')}</Button><Button size="sm" variant="primary" busy={busy} onClick={approve}>{t('tr.approvePublish')}</Button></span>
                : <Button size="sm" variant="primary" busy={busy} disabled={!text.trim()} onClick={runPreview}>{t('tr.previewApprove')}</Button>}
            </div>
          </div>
        )}
        <span className="tr-label">{t('tr.rulesFollows', { n: t.num(on) })}</span>
        {d.rules.length === 0 ? <p className="small muted">{t('tr.noRulesSub')}</p> : (
          <ul className="tr-rulelist">
            {d.rules.map((r) => (
              <li key={r.id} className={r.enabled ? '' : 'off'}>
                <Pill tone={CAT_TONE[r.category] ?? 'gray'}>{t(`tr.cat.${r.category}`, {})}</Pill>
                <span className="grow bn-ok">{r.text}</span>
                <small className="muted">{r.author || t('tr.byDefault')}</small>
                {teach && <button type="button" className="tr-x" onClick={() => remove(r)} aria-label={t('common.delete')}>×</button>}
                <Toggle size="sm" checked={r.enabled} disabled={!teach} onChange={(v) => patch(r, { enabled: v })} label={t('tr.ruleOn')} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className="tr-seeside" aria-live="polite">
        <small className="muted">{t('tr.howSees')}</small>
        <div className="tr-phone">
          {preview ? (
            <>
              <div className="bubble cust bn-ok">{preview.question}</div>
              {preview.ai ? <div className="bubble shop bn-ok">{preview.reply}</div> : <small className="faint">{t('tr.noAiPreview')}</small>}
            </>
          ) : <small className="faint">{t('tr.previewFirst')}</small>}
        </div>
        {preview?.before && <small className="muted bn-ok">{t('tr.before', { r: preview.before })}</small>}
        {preview && <small className="muted">{t('tr.willBe', { c: t(`tr.cat.${preview.category}`, {}) })}</small>}
      </aside>
    </div>
  );
}

function Versions({ t, d, teach, onChange }) {
  async function rollback(v) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('tr.rollbackConfirm', { n: v.number }))) return;
    try { const r = await dash(`/training/versions/${v.number}/rollback`, { method: 'POST' }); toast(t('tr.rolledBack', { n: r.restored, v: r.version }), 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  if (d.versions.length === 0) return <Empty icon="sparkle" title={t('tr.noVersions')} />;
  return (
    <ul className="tr-versions">
      {d.versions.map((v) => (
        <li key={v.id} className={v.live ? 'live' : ''}>
          <strong className="tr-vn">v{t.num(v.number)}</strong>
          <span className="grow">
            <strong className="bn-ok">{v.summary}</strong>
            <small className="muted">{[v.by || t('tr.src.setup'), t(`tr.src.${v.source || 'setup'}`, {}), t.ago(v.at)].filter(Boolean).join(' · ')}</small>
          </span>
          {v.live ? <Pill tone="green">{t('tr.live')}</Pill> : (
            <>
              <Pill tone="gray">{t('tr.earlier')}</Pill>
              {teach && <Button size="sm" onClick={() => rollback(v)}>{t('tr.rollback')}</Button>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
