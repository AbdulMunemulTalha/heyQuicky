import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Avatar, Button, Checkbox, Empty, ErrorState, Pill, Skeleton, Tabs, toast } from '../ui/kit.jsx';
import './inbox.css';
import './comments.css';

// Screen 14: comments on Facebook and Instagram posts — reply in public, send a private DM, or hide.
export default function Comments({ params }) {
  const t = useT();
  const { socket } = useDash();
  const [platform, setPlatform] = useState('facebook');
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState(null);
  const postId = params.postId ? Number(params.postId) : posts?.posts[0]?.id ?? null;

  const loadPosts = useCallback(() => dash(`/comments/posts?platform=${platform}`).then(setPosts, setError), [platform]);
  useEffect(() => { loadPosts(); }, [loadPosts]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('comment', loadPosts);
    return () => socket.off('comment', loadPosts);
  }, [socket, loadPosts]);

  return (
    <div className="inbox comments">
      <section className="ib-list" aria-label={t('cm.title')}>
        <header className="ib-list-head">
          <h1>{t('cm.title')}</h1>
          <button type="button" className="btn btn-link small" onClick={() => navigate('/inbox')}>{t('cm.messages')} →</button>
        </header>
        <div className="ib-channels">
          {['facebook', 'instagram'].map((p) => (
            <button key={p} type="button" className={`chip${platform === p ? ' on' : ''}`} onClick={() => { setPlatform(p); navigate('/comments'); }}>{t(`cm.${p}`)}</button>
          ))}
        </div>
        <div className="ib-rows">
          {error ? <ErrorState thing={t('cm.title')} error={error} onRetry={loadPosts} />
            : !posts ? <div className="ib-row"><Skeleton h={50} /></div>
              : posts.posts.length === 0 ? <Empty icon="chat" title={t('cm.noPosts')}>{t('cm.noPostsSub')}</Empty>
                : posts.posts.map((p) => (
                  <button key={p.id} type="button" className={`cm-post${p.id === postId ? ' on' : ''}`} onClick={() => navigate(`/comments/${p.id}`)}>
                    <span className="cm-thumb" style={p.image ? { backgroundImage: `url(${p.image})` } : undefined} />
                    <span className="grow">
                      <strong className="bn-ok">{p.caption || t('cm.untitled')}</strong>
                      <small className="muted">{t.date(p.postedAt)} · {t('cm.nComments', { n: p.total })}</small>
                      <span className="ib-signals">
                        {p.needsYou > 0 && <Pill tone="yellow">{t('cm.needYou', { n: p.needsYou })}</Pill>}
                        <Pill>{t('cm.total', { n: p.total })}</Pill>
                      </span>
                    </span>
                  </button>
                ))}
        </div>
      </section>
      {postId ? <PostThread key={postId} id={postId} t={t} onChanged={loadPosts} /> : <div className="chat chat-empty"><Empty icon="chat" title={t('cm.pick')} /></div>}
    </div>
  );
}

function PostThread({ id, t, onChanged }) {
  const { socket, can } = useDash();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(null);
  const load = useCallback(() => dash(`/comments/posts/${id}`).then((d) => { setData(d); setSelected((s) => s ?? d.comments.find((c) => c.status === 'needs_you')?.id ?? d.comments[0]?.id); }, setError), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    const on = (e) => { if (e.postId === id) load(); };
    socket.on('comment', on);
    return () => socket.off('comment', on);
  }, [socket, id, load]);

  if (error) return <div className="chat"><ErrorState thing={t('cm.post')} error={error} onRetry={load} /></div>;
  if (!data) return <div className="chat"><div className="chat-body"><Skeleton h={80} /></div></div>;
  const { post, counts } = data;
  const shown = data.comments.filter((c) => tab === 'all' || c.status === tab);
  const sel = data.comments.find((c) => c.id === selected);

  return (
    <>
      <section className="chat" aria-label={t('cm.post')}>
        <header className="cm-head">
          <span className="cm-thumb lg" style={post.image ? { backgroundImage: `url(${post.image})` } : undefined} />
          <div className="grow">
            <h2 className="bn-ok">{post.caption || t('cm.untitled')}</h2>
            <p className="small muted">{post.channelName} · {t.date(post.postedAt)}{post.products[0] && <> · {t('cm.linkedTo')} <a href={`/app/catalog/${post.products[0].id}`} onClick={(e) => { e.preventDefault(); navigate(`/catalog/${post.products[0].id}`); }}>{post.products[0].name}</a></>}</p>
            <div className="ib-signals">
              {post.aiReplying && <Pill tone="green">{t('cm.aiReplying')}</Pill>}
              <Pill>{t('cm.replyAndDm')}</Pill>
              {post.rules?.hide_phones !== false && <Pill>{t('cm.autoHidePhones')}</Pill>}
            </div>
          </div>
          <Button size="sm" onClick={() => window.open(post.platform === 'instagram' ? 'https://www.instagram.com/' : 'https://www.facebook.com/', '_blank', 'noopener')}>{t('cm.openPost')}</Button>
        </header>
        <Tabs className="cm-tabs" value={tab} onChange={setTab} items={[
          { key: 'all', label: t('common.all'), count: counts.all },
          { key: 'needs_you', label: t('cm.tab.needs'), count: counts.needs_you },
          { key: 'ai_replied', label: t('cm.tab.ai'), count: counts.ai_replied },
          { key: 'hidden', label: t('cm.tab.hidden'), count: counts.hidden },
        ]} />
        <div className="chat-body">
          {shown.length === 0 ? <Empty icon="check" tone="green" title={t('cm.none')} /> : (
            <ul className="cm-list">
              {shown.map((c) => <CommentCard key={c.id} c={c} t={t} active={c.id === selected} onSelect={() => setSelected(c.id)} canReply={can('reply')} onDone={() => { load(); onChanged(); }} />)}
            </ul>
          )}
        </div>
      </section>
      <aside className="ib-panel cm-dm">
        {sel ? (
          <>
            <div className="row">
              <Avatar name={sel.author} size={34} />
              <div className="grow"><strong>{sel.author}</strong><br /><small className="muted">{t('cm.privateChat')}</small></div>
              {sel.conversationId && <Button size="sm" onClick={() => navigate(`/inbox/${sel.conversationId}`)}>{t('cm.openInInbox')}</Button>}
            </div>
            <p className="cm-started">{t('cm.startedFrom', { post: (post.caption || '').slice(0, 30) })}</p>
            {sel.dmSent || sel.conversationId
              ? <p className="small muted">{sel.dmSent ? t('cm.dmSentNote') : t('cm.hasChat')}</p>
              : <p className="small muted">{t('cm.noDmYet')}</p>}
          </>
        ) : <p className="muted small">{t('cm.pickComment')}</p>}
      </aside>
    </>
  );
}

const STATUS_PILL = { needs_you: ['yellow', 'cm.st.needs'], ai_replied: ['blue', 'cm.st.ai'], replied: ['green', 'cm.st.replied'], hidden: ['gray', 'cm.st.hidden'] };

function CommentCard({ c, t, active, onSelect, canReply, onDone }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [dmToo, setDmToo] = useState(true);
  const [dm, setDm] = useState('');
  const [busy, setBusy] = useState(false);
  const [tone, label] = STATUS_PILL[c.status] ?? STATUS_PILL.needs_you;

  async function post(path, body, ok) {
    setBusy(true);
    try {
      await dash(`/comments/${c.id}/${path}`, { method: 'POST', body });
      toast(ok);
      setOpen(false);
      setText('');
      onDone();
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(false); }
  }

  return (
    <li className={`cm-card${active ? ' on' : ''}${c.status === 'hidden' ? ' hidden-c' : ''}`} onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onSelect(); }} tabIndex={0}>
      <div className="row">
        <Avatar name={c.author} size={28} />
        <strong className="small">{c.author || t('cm.unknown')}</strong>
        <span className="faint small">{t.ago(c.at)}</span>
        <Pill tone={tone}>{t(label)}{c.status === 'hidden' && c.hiddenReason ? ` · ${c.hiddenReason}` : ''}</Pill>
      </div>
      <p className="cm-text bn-ok">{c.text}</p>
      {c.aiReason && <p className="faint small bn-ok">{t('cm.aiLeft', { reason: c.aiReason })}</p>}
      {canReply && (
        <div className="cm-actions">
          <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{t('cm.reply')}</button>
          {c.status === 'hidden'
            ? <button type="button" onClick={(e) => { e.stopPropagation(); post('hide', { hidden: false }, t('cm.unhidden')); }}>{t('cm.unhide')}</button>
            : <button type="button" onClick={(e) => { e.stopPropagation(); post('hide', { hidden: true }, t('cm.hiddenOk')); }}>{t('cm.hide')}</button>}
          <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); setDmToo(true); }}>{t('cm.openDm')}</button>
        </div>
      )}
      {c.reply && (
        <div className="cm-reply">
          <p className="bn-ok">{c.reply}</p>
          <small className="faint">{c.repliedBy}{c.dmSent && ` · ${t('cm.dmSent')}`}</small>
        </div>
      )}
      {open && (
        <form className="cm-form" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); post('reply', { text, dm: dmToo ? (dm || text) : '' }, t('cm.sent')); }}>
          <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('cm.publicPlaceholder')} aria-label={t('cm.publicPlaceholder')} autoFocus />
          <Checkbox checked={dmToo} onChange={setDmToo} label={t('cm.alsoDm')} />
          {dmToo && <textarea className="input" rows={2} value={dm} onChange={(e) => setDm(e.target.value)} placeholder={t('cm.dmPlaceholder')} aria-label={t('cm.dmPlaceholder')} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!text.trim() && !(dmToo && dm.trim())}>{t('cm.reply')}</Button>
          </div>
        </form>
      )}
    </li>
  );
}
