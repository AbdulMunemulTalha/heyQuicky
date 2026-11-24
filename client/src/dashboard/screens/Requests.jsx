import { useEffect, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { session } from '../../api.js';
import { navigate } from '../lib/router.jsx';
import { Button, Skeleton, toast } from '../ui/kit.jsx';

// UX-05 · Help → Requests (frame "UX-05 · In-app feature requests"): ask by text or voice, see what happened.
const TONE = { reviewing: 'yellow', planned: 'purple', in_progress: 'blue', done: 'green', not_now: 'gray' };

export default function Requests({ t, onClose }) {
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [similar, setSimilar] = useState([]);
  const [busy, setBusy] = useState('');
  const [recording, setRecording] = useState(false);
  const recorder = useRef(null);
  const load = () => dash(`/requests?lang=${t.lang}`).then(setD).catch((err) => toast(err.message, 'red'));
  useEffect(() => { load(); }, [t.lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Others asked for this too": while typing, requests that sound the same.
  useEffect(() => {
    if (text.trim().length < 12) { setSimilar([]); return undefined; }
    const timer = setTimeout(() => dash(`/requests/similar?lang=${t.lang}&q=${encodeURIComponent(text.trim())}`).then((r) => setSimilar(r.similar)).catch(() => {}), 400);
    return () => clearTimeout(timer);
  }, [text, t.lang]);

  async function send() {
    setBusy('send');
    try {
      await dash('/requests', { method: 'POST', body: { text, voice } });
      setText(''); setVoice(''); setSimilar([]);
      toast(t('rq.sent'), 'green');
      load();
    } catch (err) { toast(err.message, 'red'); }
    setBusy('');
  }
  async function vote(r) {
    try {
      await dash(`/requests/${r.id}/vote`, { method: r.voted ? 'DELETE' : 'POST' });
      if (!r.voted) { toast(t('rq.voted'), 'green'); setSimilar((s) => s.filter((x) => x.id !== r.id)); }
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  // Hold to speak: record while held; the words go in the box (and the voice note goes with the request).
  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunks, { type: rec.mimeType.split(';')[0] || 'audio/webm' });
        if (blob.size < 2000) return;
        setBusy('voice');
        try {
          const res = await fetch('/api/dash/requests/voice', { method: 'POST', headers: { 'content-type': blob.type, authorization: `Bearer ${session.token}` }, body: blob });
          const r = await res.json();
          if (!res.ok) throw new Error(r.error);
          setVoice(r.voice);
          if (r.text) setText((x) => [x.trim(), r.text].filter(Boolean).join(' '));
        } catch (err) { toast(err.message, 'red'); }
        setBusy('');
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch { toast(t('rq.noMic'), 'red'); }
  }
  function stopRec() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    setRecording(false);
  }

  return (
    <div className="rq">
      <label htmlFor="rq-text" className="rq-label">{t('rq.ask')}</label>
      <textarea id="rq-text" className="input bn-ok" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('rq.ph')} maxLength={1000} />
      {voice && <div className="rq-voice"><audio src={voice} controls aria-label={t('rq.yourVoice')} /><button type="button" className="rq-x" onClick={() => setVoice('')} aria-label={t('rq.removeVoice')}>×</button></div>}
      <div className="rq-row">
        <button type="button" className={`btn rq-speak${recording ? ' on' : ''}`} aria-pressed={recording}
          onPointerDown={startRec} onPointerUp={stopRec} onPointerLeave={() => recording && stopRec()}
          onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !recording && !e.repeat) { e.preventDefault(); startRec(); } }}
          onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stopRec(); } }}>
          🎙 {recording ? t('rq.listening') : busy === 'voice' ? t('rq.writing') : t('rq.hold')}
        </button>
        <Button variant="primary" busy={busy === 'send'} disabled={!text.trim() && !voice} onClick={send}>{t('rq.send')}</Button>
      </div>
      {similar.length > 0 && (
        <div className="rq-similar" role="status">
          <small className="muted">{t('rq.similar')}</small>
          {similar.map((r) => <Item key={r.id} t={t} r={r} onVote={() => vote(r)} />)}
        </div>
      )}
      <h4 className="rq-h">{t('rq.yours')}</h4>
      {!d ? <Skeleton h={160} r={10} /> : d.requests.length === 0 ? <p className="small muted">{t('rq.none')}</p> : (
        <ul className="rq-list">{d.requests.map((r) => <li key={r.id}><Item t={t} r={r} onVote={() => vote(r)} onGo={r.link ? () => { onClose(); navigate(r.link); } : null} /></li>)}</ul>
      )}
    </div>
  );
}

function Item({ t, r, onVote, onGo }) {
  return (
    <div className="rq-item">
      <button type="button" className={`rq-vote${r.voted ? ' on' : ''}`} onClick={onVote} disabled={r.mine && r.voted}
        aria-pressed={r.voted} aria-label={r.voted ? t('rq.votedLabel', { n: r.votes }) : t('rq.voteLabel', { n: r.votes })}>
        <span aria-hidden="true">▲</span><strong>{t.num(r.votes)}</strong>
      </button>
      <div className="grow">
        <strong className="bn-ok">{r.title}</strong>
        <small className="muted bn-ok">{r.note}{onGo && <> — <button type="button" className="rq-link" onClick={onGo}>{t('rq.tryIt')}</button></>}</small>
      </div>
      <span className={`rq-pill tone-${TONE[r.status]}`}>{t(`rq.st.${r.status}`)}</span>
    </div>
  );
}
