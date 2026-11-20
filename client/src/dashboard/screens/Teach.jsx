import { useEffect, useRef, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { navigate } from '../lib/router.jsx';
import { Button, Checkbox, Modal, Skeleton, toast } from '../ui/kit.jsx';
import './agent.css';

const REASONS = ['wrong_info', 'misunderstood', 'should_hand_off', 'tone', 'made_up', 'too_long'];
const STEPS = ['reason', 'fix', 'done'];

// Teach popup (TRN-02/03/05, frames TeachReason → TeachPopup → TeachDone): from an AI reply in a chat
// (what was wrong → the right answer → published), or from an unanswered question (right answer → published).
export default function Teach({ messageId, unanswered, onDone, onClose }) {
  const t = useT();
  const [src, setSrc] = useState(unanswered ? { asked: unanswered.question, replied: null, suggestions: [], sizeChart: null, voice: false } : null);
  const [step, setStep] = useState(unanswered ? 'fix' : 'reason');
  const [reason, setReason] = useState('');
  const [answer, setAnswer] = useState('');
  const [when, setWhen] = useState([]);
  const [custom, setCustom] = useState('');
  const [sendChart, setSendChart] = useState(true);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [recording, setRecording] = useState(false);
  const recorder = useRef(null);

  useEffect(() => {
    if (!messageId) return;
    dash(`/training/teach/${messageId}`).then((x) => { setSrc(x); setWhen(x.suggestions.slice(0, 1)); }, (err) => { toast(err.message, 'red'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  // "Preview on the customer's phone": the AI answers with this answer added (nothing saved).
  useEffect(() => {
    if (step !== 'fix' || !answer.trim() || !src?.asked) { setPreview(null); return undefined; }
    const timer = setTimeout(() => dash('/agent/preview', { method: 'POST', body: { question: src.asked, answer } }).then(setPreview).catch(() => {}), 700);
    return () => clearTimeout(timer);
  }, [answer, step, src]);

  const toggleWhen = (w) => setWhen((list) => (list.includes(w) ? list.filter((x) => x !== w) : [...list, w].slice(0, 5)));
  function addCustom() {
    const w = custom.trim();
    if (w && !when.includes(w)) setWhen([...when, w].slice(0, 5));
    setCustom('');
  }

  // "Hold to speak": record while the button is held, then the words fill the answer.
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunks, { type: rec.mimeType.split(';')[0] || 'audio/webm' });
        if (blob.size < 2000) return;
        try {
          const res = await fetch('/api/dash/training/transcribe', { method: 'POST', headers: { 'content-type': blob.type, authorization: `Bearer ${session.token}` }, body: blob });
          const r = await res.json();
          if (!res.ok) throw new Error(r.error);
          setAnswer((a) => [a.trim(), r.text].filter(Boolean).join(' '));
        } catch (err) { toast(err.message, 'red'); }
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch { toast(t('tc.noMic'), 'red'); }
  }
  function stopRecording() {
    recorder.current?.state === 'recording' && recorder.current.stop();
    setRecording(false);
  }

  async function publish() {
    setBusy(true);
    try {
      const body = { answer, when, sizeChartProductId: src.sizeChart && sendChart ? src.sizeChart.productId : null };
      const out = unanswered
        ? await dash(`/agent/unanswered/${unanswered.id}/teach`, { method: 'POST', body: { answer, when } })
        : await dash(`/training/teach/${messageId}`, { method: 'POST', body: { ...body, reason } });
      setDone({ version: out.version, tested: out.tested ?? preview?.reply ?? null });
      setStep('done');
      onDone?.();
    } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function undo() {
    try { const r = await dash('/agent/undo', { method: 'POST' }); toast(t('ag.undone', { n: r.restored }), 'green'); onDone?.(); onClose(); } catch (err) { toast(err.message, 'red'); }
  }

  const stepsShown = unanswered ? STEPS.slice(1) : STEPS;
  const footer = step === 'reason' ? <Button variant="primary" disabled={!reason} onClick={() => setStep('fix')}>{t('tc.next')}</Button>
    : step === 'fix' ? <>{!unanswered && <Button onClick={() => setStep('reason')}>{t('tc.back')}</Button>}<Button variant="primary" busy={busy} disabled={!answer.trim()} onClick={publish}>{t('tc.publish')}</Button></>
      : <Button variant="primary" onClick={onClose}>{t('common.done')}</Button>;
  const phoneReply = step === 'reason' ? src?.replied : step === 'fix' ? preview?.reply : done?.tested;

  return (
    <Modal title={t('tc.title')} subtitle={t('tc.sub')} onClose={onClose} width={860} className="teach" footer={(
      <div className="tc-foot"><small className="muted">{t('tc.versionNote')}</small><span className="grow" />{footer}</div>
    )}>
      <ol className="tc-steps" aria-label={t('tc.title')}>
        {stepsShown.map((s, i) => {
          const at = stepsShown.indexOf(step);
          return <li key={s} className={i < at ? 'past' : i === at ? 'now' : ''}><span className="tc-num">{i < at ? '✓' : i + 1}</span>{t(`tc.stepName.${s}`)}</li>;
        })}
      </ol>
      {!src ? <Skeleton h={240} r={12} /> : (
        <div className="tc-grid">
          <div className="tc-main">
            <span className="small muted">{t('tc.asked')}</span>
            <div className="tc-b cust bn-ok">{src.asked || '—'}</div>
            {src.replied && (
              <>
                <span className="small muted">{t('tc.replied')}</span>
                <div className={`tc-b ai bn-ok${step !== 'reason' ? ' struck' : ''}`}>{src.replied}</div>
              </>
            )}
            {step === 'reason' && (
              <fieldset className="tc-reasons">
                <legend className="small"><strong>{t('tc.wrong')}</strong></legend>
                {REASONS.map((r) => (
                  <label key={r} className={`tc-reason${reason === r ? ' on' : ''}`}>
                    <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                    <span>{t(`tc.reason.${r}`)}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {step === 'fix' && (
              <>
                <label className="small" htmlFor="tc-answer"><strong>{t('tc.right')}</strong></label>
                <textarea id="tc-answer" className="input" rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('tc.rightPlaceholder')} maxLength={2000} autoFocus />
                <div className="tc-voice">
                  <small className="muted">{t('tc.writeHint')}</small>
                  {src.voice && (
                    <button type="button" className={`tc-mic${recording ? ' on' : ''}`} onPointerDown={startRecording} onPointerUp={stopRecording} onPointerLeave={() => recording && stopRecording()}
                      aria-pressed={recording}>{recording ? t('tc.listening') : t('tc.holdToSpeak')}</button>
                  )}
                </div>
                <span className="small"><strong>{t('tc.when')}</strong></span>
                <div className="tc-when">
                  {[...new Set([...src.suggestions, ...when])].map((w) => (
                    <button key={w} type="button" className={`chip${when.includes(w) ? ' on' : ''}`} aria-pressed={when.includes(w)} onClick={() => toggleWhen(w)}>{w}</button>
                  ))}
                  <input className="input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t('tc.whenPlaceholder')} aria-label={t('tc.when')}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} onBlur={addCustom} maxLength={80} />
                </div>
                {src.sizeChart && <Checkbox checked={sendChart} onChange={setSendChart} label={t('tc.sendChart')} hint={src.sizeChart.name} />}
                {reason === 'should_hand_off' && <p className="small muted">{t('tc.handoffNote')}</p>}
              </>
            )}
            {step === 'done' && (
              <div className="tc-published">
                <span className="tc-check" aria-hidden="true">✓</span>
                <div>
                  <strong>{t('tc.doneTitle', { n: t.num(done.version) })}</strong>
                  <p className="small">{t('tc.doneSub')}</p>
                  <p className="small">
                    <button type="button" className="tc-link" onClick={() => { onClose(); navigate('/agent/training?tab=versions'); }}>{t('tc.allVersions')}</button>
                    {' · '}
                    <button type="button" className="tc-link" onClick={undo}>{t('tc.undo')}</button>
                  </p>
                </div>
              </div>
            )}
          </div>
          <aside className="tc-phone" aria-live="polite">
            <span className="small muted">{t('tc.phone')}</span>
            <div className="tc-screen">
              <div className="tc-shop"><strong className="small">{t('tc.shop')}</strong><span className="tc-tag">{t('tc.previewTag')}</span></div>
              <div className="tc-b cust bn-ok">{src.asked || '—'}</div>
              {phoneReply ? <div className="tc-b shop bn-ok">{phoneReply}</div> : <small className="faint">{t('tc.typeToPreview')}</small>}
              {step !== 'reason' && src.sizeChart && sendChart && <div className="tc-chart"><strong>SIZE CHART</strong><span /><span /><span /></div>}
            </div>
          </aside>
        </div>
      )}
    </Modal>
  );
}
