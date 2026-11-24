import { useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Button, Modal, Skeleton, toast } from '../ui/kit.jsx';

// UX-04 · Help → What's new (frame "UX-04 · Feature announcements") and the announcement bar.
const TONE = { new: 'yellow', improved: 'blue', fixed: 'green' };

const youtube = (url) => url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/)?.[1];

export function VideoModal({ t, item, onClose }) {
  const id = youtube(item.video);
  return (
    <Modal title={item.title} onClose={onClose} width={720}>
      <div className="wn-video">
        {id ? <iframe src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`} title={item.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          : <video src={item.video} controls autoPlay aria-label={item.title} />}
      </div>
      {item.link && <Button style={{ marginTop: 12 }} onClick={() => { onClose(); navigate(item.link); }}>{t('wn.tryIt')}</Button>}
    </Modal>
  );
}

const length = (t, s) => (s >= 60 ? t('wn.min', { n: t.num(Math.round(s / 60)) }) : t('wn.sec', { n: t.num(s) }));

export function WhatsNewList({ t, onGo }) {
  const { setMe } = useDash();
  const [d, setD] = useState(null);
  const [video, setVideo] = useState(null);
  useEffect(() => {
    // Show what was unread, then mark it read (the dot on Help goes away).
    dash(`/whats-new?lang=${t.lang}`).then((x) => {
      setD(x);
      if (x.unread) dash('/whats-new/seen', { method: 'POST' }).then(() => setMe((m) => (m ? { ...m, badges: { ...m.badges, whatsNew: 0 } } : m))).catch(() => {});
    }).catch((err) => toast(err.message, 'red'));
  }, [t.lang, setMe]);
  if (!d) return <Skeleton h={300} r={12} />;
  if (!d.items.length) return <p className="small muted">{t('wn.none')}</p>;
  const date = (x) => new Date(x).toLocaleDateString(t.lang === 'bn' ? 'bn-BD' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Dhaka' });
  return (
    <>
      <ul className="wn-list">
        {d.items.map((a) => (
          <li key={a.id} className={`wn-item${a.unread ? ' unread' : ''}`}>
            <div className="wn-top"><span className={`wn-tag tone-${TONE[a.kind]}`}>{t(`wn.kind.${a.kind}`)}</span>{a.unread && <span className="wn-dot" aria-label={t('wn.unread')} />}<span className="grow" /><time className="small muted">{date(a.date)}</time></div>
            <strong className="bn-ok">{a.title}</strong>
            {a.body && <p className="small muted bn-ok">{a.body}</p>}
            {a.asked && <p className="small wn-asked">{t('wn.asked')}</p>}
            <div className="wn-actions">
              {a.video && <button type="button" className="btn btn-sm" onClick={() => setVideo(a)}>▶ {t('wn.watch')} {a.seconds ? <span className="muted">{length(t, a.seconds)}</span> : null}</button>}
              {a.link && <button type="button" className="btn btn-sm" onClick={() => onGo(a.link)}>{t('wn.show')}</button>}
            </div>
          </li>
        ))}
      </ul>
      {video && <VideoModal t={t} item={video} onClose={() => setVideo(null)} />}
    </>
  );
}

// The bar above every screen for the newest announcement that has one; × hides it for good.
export function WhatsNewBar() {
  const { t, me, openOverlay } = useDash();
  const [bar, setBar] = useState(null);
  const [video, setVideo] = useState(null);
  const unread = me.badges?.whatsNew ?? 0;
  useEffect(() => {
    if (!unread) { setBar(null); return; }
    dash(`/whats-new?lang=${t.lang}`).then((x) => setBar(x.bar)).catch(() => {});
  }, [unread, t.lang]);
  if (!bar) return null;
  async function dismiss() {
    setBar(null);
    await dash(`/whats-new/${bar.id}/dismiss`, { method: 'POST' }).catch(() => {});
  }
  return (
    <div className="sys-banner tone-blue wn-bar" role="status">
      <span className={`wn-tag tone-${TONE[bar.kind]}`}>{t(`wn.kind.${bar.kind}`)}</span>
      <div className="grow"><strong className="bn-ok">{bar.title}</strong>{bar.body && <span className="bn-ok">{bar.body}</span>}</div>
      {bar.video ? <Button size="sm" onClick={() => setVideo(bar)}>▶ {t('wn.watch')}{bar.seconds ? ` · ${length(t, bar.seconds)}` : ''}</Button>
        : bar.link ? <Button size="sm" onClick={() => navigate(bar.link)}>{t('wn.show')}</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => openOverlay('help', { tab: 'new' })}>{t('wn.seeAll')}</Button>
      <button type="button" className="wn-x" onClick={dismiss} aria-label={t('wn.dismiss')}>×</button>
      {video && <VideoModal t={t} item={video} onClose={() => setVideo(null)} />}
    </div>
  );
}
