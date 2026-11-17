import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, setQuery } from '../lib/router.jsx';
import { Icon } from '../ui/icons.jsx';
import { Avatar, Button, Checkbox, Empty, ErrorState, Modal, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import './inbox.css';

const TABS = ['waiting', 'unread', 'open', 'done', 'spam'];
const PLATFORM = { messenger: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp', web: 'Website' };

// Screens 02, 22 and 22b: the unified inbox with its tabs, takeover, side panel, bulk actions and spam folder.
export default function Inbox({ params, query }) {
  const t = useT();
  const { socket, me, refreshBadges } = useDash();
  const tab = TABS.includes(query.tab) ? query.tab : 'open';
  const scope = query.scope === 'mine' ? 'mine' : 'everyone';
  const channel = query.channel ?? '';
  const selectedId = params.id ? Number(params.id) : null;
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [checked, setChecked] = useState([]);
  const [search, setSearch] = useState('');

  const loadList = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ tab, scope, ...(channel ? { channel } : {}), ...(search ? { q: search } : {}) });
      setList(await dash(`/inbox?${qs}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [tab, scope, channel, search]);

  useEffect(() => { loadList(); setChecked([]); }, [loadList]);

  // Live: any change to a chat refreshes the list (debounced) and the sidebar badges.
  useEffect(() => {
    if (!socket) return undefined;
    let timer;
    const onChange = () => { clearTimeout(timer); timer = setTimeout(() => { loadList(); refreshBadges(); }, 400); };
    socket.on('conversation', onChange);
    socket.on('message', onChange);
    return () => { clearTimeout(timer); socket.off('conversation', onChange); socket.off('message', onChange); };
  }, [socket, loadList, refreshBadges]);

  const open = (id) => navigate(`/inbox/${id}${window.location.search}`);

  return (
    <div className={`inbox${selectedId ? ' has-chat' : ''}`}>
      <ListColumn t={t} tab={tab} scope={scope} channel={channel} list={list} error={error} reload={loadList}
        selectedId={selectedId} onOpen={open} checked={checked} setChecked={setChecked} search={search} setSearch={setSearch} />
      {selectedId
        ? <Chat key={selectedId} id={selectedId} t={t} me={me} onChanged={loadList} tab={tab} />
        : <div className="chat chat-empty"><Empty icon="chat" title={t('inbox.pick')}>{t('inbox.pickSub')}</Empty></div>}
    </div>
  );
}

function ListColumn({ t, tab, scope, channel, list, error, reload, selectedId, onOpen, checked, setChecked, search, setSearch }) {
  const items = list?.items ?? [];
  const allChecked = items.length > 0 && checked.length === items.length;
  const [assignFor, setAssignFor] = useState(null);

  async function bulk(action, extra = {}) {
    try {
      const { changed } = await dash('/inbox/bulk', { method: 'POST', body: { ids: checked, action, ...extra } });
      toast(t('inbox.bulkDone', { n: changed }));
      setChecked([]);
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }
  async function tagSelected() {
    // eslint-disable-next-line no-alert
    const tag = window.prompt(t('inbox.tagPrompt'));
    if (tag) bulk('tag', { tag });
  }
  async function markAllRead() {
    try { await dash('/inbox/mark-all-read', { method: 'POST', body: { tab } }); reload(); } catch (err) { toast(err.message, 'red'); }
  }
  async function tidy() {
    try {
      const { changed } = await dash('/inbox/tidy', { method: 'POST', body: { tab } });
      toast(t('inbox.tidied', { n: changed }));
      reload();
    } catch (err) { toast(err.message, 'red'); }
  }

  const total = list ? Object.entries(list.channels).filter(([k]) => k !== 'comments').reduce((s, [, n]) => s + n, 0) : 0;
  return (
    <section className="ib-list" aria-label={t('nav.inbox')}>
      <header className="ib-list-head">
        <h1>{t('nav.inbox')}</h1>
        <div className="segmented" role="radiogroup" aria-label={t('inbox.scope')}>
          {['everyone', 'mine'].map((s) => (
            <button key={s} type="button" role="radio" aria-checked={scope === s} className={scope === s ? 'on' : ''}
              onClick={() => setQuery({ scope: s === 'everyone' ? null : s })}>{t(`inbox.${s}`)}</button>
          ))}
        </div>
      </header>
      <div className="ib-search">
        <Icon name="search" size={14} />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('inbox.searchList')} aria-label={t('inbox.searchList')} />
      </div>
      <div className="ib-channels" role="group" aria-label={t('inbox.channels')}>
        <button type="button" className={`chip${!channel ? ' on' : ''}`} onClick={() => setQuery({ channel: null })}>{t('common.all')} <span className="chip-count">{t.num(total)}</span></button>
        {['messenger', 'instagram', 'whatsapp', 'web'].filter((p) => list?.channels[p] !== undefined).map((p) => (
          <button key={p} type="button" className={`chip${channel === p ? ' on' : ''}`} onClick={() => setQuery({ channel: p })}>
            {PLATFORM[p]} <span className="chip-count">{t.num(list.channels[p])}</span>
          </button>
        ))}
        <button type="button" className="chip" onClick={() => navigate('/comments')}>{t('inbox.comments')} <span className="chip-count">{t.num(list?.channels.comments ?? 0)}</span></button>
      </div>
      <div className="tabs ib-tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setQuery({ tab: k === 'open' ? null : k })}>
            {t(`inbox.tab.${k}`)} <span className="tab-count">{list ? t.num(list.counts[k]) : ''}</span>
          </button>
        ))}
      </div>

      {checked.length > 0 ? (
        <div className="ib-bulk" role="toolbar" aria-label={t('inbox.bulk')}>
          <Checkbox checked={allChecked} onChange={(v) => setChecked(v ? items.map((i) => i.id) : [])} label={t('inbox.selected', { n: checked.length })} />
          <span className="grow" />
          {tab === 'done' && <button type="button" className="btn btn-sm" onClick={() => bulk('reopen')}>{t('inbox.reopen')}</button>}
          {tab === 'spam' && <button type="button" className="btn btn-sm" onClick={() => bulk('not_spam')}>{t('inbox.notSpam')}</button>}
          {tab !== 'done' && tab !== 'spam' && <button type="button" className="btn btn-sm" onClick={() => bulk('done')}>{t('inbox.done')}</button>}
          <button type="button" className="btn btn-sm" onClick={() => setAssignFor('bulk')}>{t('inbox.assign')}</button>
          <button type="button" className="btn btn-sm" onClick={tagSelected}>{t('inbox.tag')}</button>
        </div>
      ) : (
        <div className="ib-tools">
          <Checkbox checked={false} onChange={() => setChecked(items.map((i) => i.id))} label={tab === 'spam' ? t('inbox.spamNote') : t('inbox.selectAll')} />
          <span className="grow" />
          <button type="button" className="btn btn-sm" onClick={markAllRead}>{t('inbox.markAllRead')}</button>
          {(tab === 'open' || tab === 'spam') && <button type="button" className="btn btn-sm" onClick={tidy} title={t('inbox.tidyHint')}>{t('inbox.tidy')}</button>}
        </div>
      )}

      <div className="ib-rows">
        {error ? <ErrorState thing={t('nav.inbox')} error={error} onRetry={reload} />
          : !list ? Array.from({ length: 6 }, (_, i) => <div key={i} className="ib-row"><Skeleton w={36} h={36} r={18} /><div className="grow"><Skeleton w="60%" /><br /><Skeleton w="90%" h={11} /></div></div>)
            : items.length === 0 ? <ListEmpty t={t} tab={tab} filtered={Boolean(channel || search)} />
              : items.map((c) => (
                <Row key={c.id} c={c} t={t} active={c.id === selectedId} checked={checked.includes(c.id)}
                  onCheck={(v) => setChecked((list2) => (v ? [...list2, c.id] : list2.filter((x) => x !== c.id)))} onOpen={() => onOpen(c.id)} />
              ))}
      </div>
      {assignFor && <AssignPopup t={t} ids={checked} onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); setChecked([]); reload(); }} />}
    </section>
  );
}

function ListEmpty({ t, tab, filtered }) {
  if (filtered) return <Empty icon="search" tone="gray" title={t('inbox.noMatch')}>{t('inbox.noMatchSub')}</Empty>;
  if (tab === 'spam') return <Empty icon="check" tone="green" title={t('inbox.noSpam')} />;
  if (tab === 'waiting') return <Empty icon="check" tone="green" title={t('inbox.noWaiting')}>{t('inbox.noWaitingSub')}</Empty>;
  return <Empty icon="inbox" title={t('inbox.emptyTitle')}>{t('inbox.emptySub')}</Empty>;
}

function Row({ c, t, active, checked, onCheck, onOpen }) {
  return (
    <div className={`ib-row${active ? ' on' : ''}${c.unread ? ' is-unread' : ''}`}>
      <input type="checkbox" className="ib-check" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={t('inbox.select', { name: c.name })} />
      <button type="button" className="ib-row-main" onClick={onOpen} aria-current={active ? 'true' : undefined}>
        <Avatar name={c.name} size={36} />
        <span className="ib-row-body">
          <span className="ib-row-top"><strong>{c.name}</strong><time>{t.ago(c.lastAt)}</time></span>
          <span className="ib-preview bn-ok">{c.preview}</span>
          <span className="ib-signals">
            {c.actNow && <Pill className="pill-act">{t('ov.tag.actNow')}</Pill>}
            {c.needsPerson && !c.actNow && c.status === 'open' && !c.spam && <Pill tone="yellow">{t('inbox.needsPerson')}</Pill>}
            {c.spam ? <Pill tone="red">{t('inbox.spamPill', { reason: c.spamReason || t('inbox.tab.spam') })}</Pill>
              : c.status === 'done' ? <Pill tone="green">{t('inbox.donePill')}</Pill>
                : <Pill tone={c.lastReplier === 'ai' || c.aiState === 'ai' ? 'blue' : 'gray'}>{c.aiState === 'ai' ? 'AI' : (c.takenOverBy || c.assignedTo?.name || t('inbox.person'))}</Pill>}
            {c.spam && c.aiOff && <Pill>{t('inbox.aiOff')}</Pill>}
            <Pill>{PLATFORM[c.platform] ?? c.platform}</Pill>
            {c.tags.slice(0, 2).map((tag) => <Pill key={tag} tone={tag === 'Back from Done' ? 'purple' : 'orange'}>{tag === 'Back from Done' ? t('inbox.backFromDone') : tag}</Pill>)}
            {c.needsPerson && c.waitingSince && c.status === 'open' && <span className="ib-wait">{t('inbox.waiting', { d: t.ago(c.waitingSince) })}</span>}
          </span>
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Chat ----

function Chat({ id, t, me, onChanged, tab }) {
  const { socket, can, openOverlay } = useDash();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [typing, setTyping] = useState(null); // { name, at } from presence
  const [assignOpen, setAssignOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const scroller = useRef(null);

  const load = useCallback(async () => {
    try {
      setData(await dash(`/inbox/${id}`));
      setError(null);
    } catch (err) { setError(err); }
  }, [id]);

  useEffect(() => {
    load();
    dash(`/inbox/${id}/read`, { method: 'POST' }).catch(() => {});
  }, [load, id]);

  // New messages and changes to this chat arrive live; presence shows teammates in the same chat.
  useEffect(() => {
    if (!socket) return undefined;
    socket.emit('presence', { conversationId: id, state: 'viewing' });
    const onMessage = (m) => { if (m.conversationId === id) load(); };
    const onConv = (c) => { if (c?.id === id) setData((d) => (d ? { ...d, conversation: { ...d.conversation, ...c } } : d)); };
    const onPresence = (p) => {
      if (p.conversationId !== id) return;
      setTyping(p.state === 'typing' ? { name: p.name, at: p.at } : null);
    };
    socket.on('message', onMessage);
    socket.on('conversation', onConv);
    socket.on('presence', onPresence);
    return () => {
      socket.emit('presence', { conversationId: id, state: 'left' });
      socket.off('message', onMessage); socket.off('conversation', onConv); socket.off('presence', onPresence);
    };
  }, [socket, id, load]);

  // "Typing" fades after a few seconds without a new signal.
  useEffect(() => {
    if (!typing) return undefined;
    const timer = setTimeout(() => setTyping(null), 6000);
    return () => clearTimeout(timer);
  }, [typing]);

  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [data?.messages.length]);

  async function act(path, body, okText) {
    try {
      const conversation = await dash(`/inbox/${id}/${path}`, { method: 'POST', body });
      setData((d) => ({ ...d, conversation: conversation ?? d.conversation }));
      if (okText) toast(okText);
      onChanged();
      load();
    } catch (err) { toast(err.message, 'red'); }
  }

  if (error) return <div className="chat"><ErrorState thing={t('inbox.chat')} error={error} onRetry={load} /></div>;
  if (!data) return <div className="chat"><div className="chat-head"><Skeleton w={200} h={20} /></div><div className="chat-body"><Skeleton h={60} /><br /><Skeleton w="60%" h={40} /></div></div>;

  const c = data.conversation;
  const mineTakeover = c.aiState === 'human' && c.takenOverBy === me.user.name;
  return (
    <>
      <section className="chat" aria-label={c.name}>
        <header className="chat-head">
          <button type="button" className="icon-btn back-mobile" onClick={() => navigate(`/inbox${window.location.search}`)} aria-label={t('common.back')}><Icon name="chevronLeft" /></button>
          <Avatar name={c.name} size={36} />
          <div className="grow">
            <h2>{c.name}</h2>
            <p className="muted small">{[PLATFORM[c.platform], c.channelName, c.vip && 'VIP'].filter(Boolean).join(' · ')}</p>
          </div>
          {c.spam ? (
            <>
              <Button size="sm" onClick={() => act('spam', { spam: false }, t('inbox.movedBack'))}>{t('inbox.notSpam')}</Button>
              <Button size="sm" variant="danger" onClick={() => act('block', {}, t('inbox.blocked'))}>{t('inbox.block')}</Button>
            </>
          ) : (
            <div className="chat-actions">
              {c.status === 'open' && c.needsPerson && !mineTakeover && <Pill tone="yellow">{t('inbox.waitingForPerson')}</Pill>}
              {c.status === 'open' && can('reply') && (mineTakeover
                ? <Button size="sm" onClick={() => act('release', {}, t('inbox.backToAiDone'))} title={c.humanUntil ? t('inbox.autoReturn', { time: t.time(c.humanUntil) }) : undefined}>{t('inbox.backToAi')}</Button>
                : <Button size="sm" variant="dark" onClick={() => act('takeover', {}, t('inbox.tookOver'))}>{t('inbox.takeOver')}</Button>)}
              <Button size="sm" onClick={() => setAssignOpen(true)}>{t('inbox.assign')}</Button>
              {c.status === 'open' && <Button size="sm" onClick={() => setSnoozeOpen(true)}>{t('inbox.later')}</Button>}
              {c.status === 'open'
                ? <Button size="sm" icon="check" onClick={() => act('done', {}, t('inbox.markedDone'))}>{t('inbox.done')}</Button>
                : <Button size="sm" onClick={() => act('reopen', {})}>{t('inbox.reopen')}</Button>}
            </div>
          )}
        </header>

        {c.spam && <div className="chat-banner red"><strong>{t('inbox.markedSpam')}</strong> {t('inbox.spamBody', { reason: c.spamReason })}</div>}
        {!c.spam && c.reopenedAt && c.status === 'open' && <div className="chat-banner blue"><strong>{t('inbox.reopened')}</strong> {t('inbox.reopenedBody', { name: c.name.split(' ')[0] })}{c.doneBy && <span className="muted"> · {t('inbox.doneBy', { name: c.doneBy })}</span>}</div>}
        {c.snoozeUntil && new Date(c.snoozeUntil) > new Date() && <div className="chat-banner"><Icon name="bell" size={14} /> {t('inbox.snoozedUntil', { time: t.dateTime(c.snoozeUntil) })}</div>}

        <div className="chat-body" ref={scroller}>
          <Messages t={t} messages={data.messages} conversation={c} />
          {c.spam && <p className="chat-system">{t('inbox.noReplySpam')}</p>}
        </div>

        {typing && <div className="chat-typing"><Avatar name={typing.name} size={20} /> <strong>{t('inbox.isTyping', { name: typing.name })}</strong> {t('inbox.typingHint')}</div>}
        {!c.spam && <Composer t={t} id={id} data={data} onSent={() => { load(); onChanged(); }} socket={socket} openOverlay={openOverlay} tab={tab} />}
      </section>
      <SidePanel t={t} data={data} id={id} reload={load} act={act} />
      {assignOpen && <AssignPopup t={t} ids={[id]} conversation={c} onClose={() => setAssignOpen(false)} onDone={() => { setAssignOpen(false); load(); onChanged(); }} />}
      {snoozeOpen && <SnoozePopup t={t} id={id} name={c.name} onClose={() => setSnoozeOpen(false)} onDone={() => { setSnoozeOpen(false); onChanged(); navigate(`/inbox${window.location.search}`); }} />}
    </>
  );
}

function Messages({ t, messages, conversation }) {
  const groups = [];
  let day = '';
  for (const m of messages) {
    const d = t.date(m.at, { weekday: 'long', day: 'numeric', month: 'short' });
    if (d !== day) { groups.push({ sep: d, at: m.at }); day = d; }
    groups.push(m);
  }
  const lastAiIdx = messages.map((m) => m.byAi).lastIndexOf(true);
  return (
    <ol className="msgs">
      {groups.map((m, i) => (m.sep
        ? <li key={`s${i}`} className="msg-sep">{m.sep} · {t.time(m.at)}</li>
        : (
          <li key={m.id} className={`msg ${m.direction}${m.byAi ? ' ai' : ''}`}>
            <div className="bubble bn-ok">
              {m.attachments?.length > 0 && <span className="msg-attach">[{m.attachments[0].type ?? 'file'}]</span>}
              {m.kind === 'order_summary' && m.payload ? <OrderCard t={t} o={m.payload} /> : m.text}
            </div>
            <div className="msg-meta">
              {m.direction === 'out' && (m.byAi ? <Pill tone="blue">AI</Pill> : <span>{m.by}</span>)}
              <time>{t.time(m.at)}</time>
              {m.status === 'failed' && <span className="error-text" title={m.error}>{t('inbox.failed')}</span>}
              {m.byAi && messages.indexOf(m) === lastAiIdx && <RateButtons t={t} />}
            </div>
          </li>
        )))}
      {conversation.needsPerson && conversation.handoffReason && conversation.status === 'open' && !conversation.takenOverBy && (
        <li className="msg-handoff">
          <strong>{t('inbox.handedToTeam', { reason: conversation.handoffReason })}</strong>
          {conversation.waitingSince && <span>{t('inbox.waitingFor', { d: t.ago(conversation.waitingSince) })}</span>}
        </li>
      )}
    </ol>
  );
}

function RateButtons({ t }) {
  const [rated, setRated] = useState(null);
  return (
    <span className="rate">
      <button type="button" aria-label={t('inbox.goodAnswer')} aria-pressed={rated === 'up'} onClick={() => { setRated('up'); toast(t('inbox.thanks')); }}>👍</button>
      <button type="button" aria-label={t('inbox.teachBetter')} aria-pressed={rated === 'down'} onClick={() => { setRated('down'); navigate('/agent'); }}>👎</button>
    </span>
  );
}

function OrderCard({ t, o }) {
  return (
    <div className="order-card">
      <div className="row"><strong>{t('inbox.orderN', { n: o.number })}</strong><span className="grow" /><Pill tone="green">{o.status}</Pill></div>
      <div className="small">{o.item}</div>
      <div className="small muted">{o.line}</div>
    </div>
  );
}

function Composer({ t, id, data, onSent, socket, openOverlay }) {
  const { can } = useDash();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [slash, setSlash] = useState(null); // matching saved replies while typing "/…"
  const [replies, setReplies] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const lastTyping = useRef(0);
  const box = useRef(null);
  const c = data.conversation;

  useEffect(() => { if (c.draft?.text && !text) setText(c.draft.text); }, [c.draft?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadReplies() {
    if (replies) return replies;
    const list = await dash('/saved-replies').catch(() => []);
    setReplies(list);
    return list;
  }

  async function onChange(v) {
    setText(v);
    if (Date.now() - lastTyping.current > 2500) {
      lastTyping.current = Date.now();
      socket?.emit('presence', { conversationId: id, state: 'typing' });
    }
    const m = /(^|\s)\/(\S*)$/.exec(v);
    if (m) {
      const list = await loadReplies();
      const q = m[2].toLowerCase();
      setSlash(list.filter((r) => r.shortcut.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q)).slice(0, 6));
    } else setSlash(null);
  }

  function pick(r) {
    setText((v) => v.replace(/(^|\s)\/\S*$/, `$1${r.text}`));
    setSavedId(r.id);
    setSlash(null);
    box.current?.focus();
  }

  async function send(e) {
    e?.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await dash(`/inbox/${id}/messages`, { method: 'POST', body: { text, savedReplyId: savedId } });
      setText('');
      setSavedId(null);
      socket?.emit('presence', { conversationId: id, state: 'viewing' });
      onSent();
    } catch (err) {
      toast(err.message, 'red');
    } finally {
      setBusy(false);
    }
  }

  async function draft() {
    try {
      const { text: d } = await dash(`/inbox/${id}/draft`, { method: 'POST' });
      setText(d);
      box.current?.focus();
    } catch (err) { toast(err.message, 'red'); }
  }

  if (!can('reply')) return null;
  return (
    <form className="composer" onSubmit={send}>
      <div className="suggested">
        <span className="muted small">{t('inbox.suggested')}</span>
        {data.suggested.map((r) => (
          <button key={r.id} type="button" className="chip chip-sm bn-ok" onClick={() => pick(r)} title={r.text}>{r.shortcut} — {r.text.slice(0, 18)}…</button>
        ))}
        <button type="button" className="chip chip-sm chip-ai" onClick={draft} disabled={!data.aiAvailable} title={data.aiAvailable ? '' : t('inbox.aiNotSetUp')}>{t('inbox.draftAi')}</button>
      </div>
      <div className="composer-box">
        {slash && (
          <ul className="slash" role="listbox" aria-label={t('nav.saved')}>
            {slash.length === 0 ? <li className="muted small">{t('inbox.noSaved')}</li> : slash.map((r) => (
              <li key={r.id}><button type="button" role="option" aria-selected="false" onClick={() => pick(r)}><strong>{r.shortcut}</strong> <span className="muted bn-ok">{r.text.slice(0, 60)}</span></button></li>
            ))}
          </ul>
        )}
        <textarea ref={box} value={text} rows={2} onChange={(e) => onChange(e.target.value)} aria-label={t('inbox.composer')}
          placeholder={c.aiState === 'ai' && c.status === 'open' ? t('inbox.placeholderAi') : t('inbox.placeholder')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSlash(null);
            if (e.key === 'Enter' && !e.shiftKey && slash?.length) { e.preventDefault(); pick(slash[0]); return; }
            if (e.key === 'Enter' && !e.shiftKey) send(e);
          }} />
        <div className="composer-actions">
          <Button size="sm" onClick={() => openOverlay('products', { conversationId: id })}>{t('inbox.product')}</Button>
          <Button size="sm" onClick={() => navigate(`/orders/new?conversation=${id}`)}>{t('inbox.order')}</Button>
          <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!text.trim()}>{t('inbox.send')}</Button>
        </div>
      </div>
      <p className="composer-tip">{t('inbox.tip')}</p>
    </form>
  );
}

// ---------------------------------------------------------- Side panel ----

function SidePanel({ t, data, id, reload, act }) {
  const { can } = useDash();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const cu = data.customer;
  const c = data.conversation;

  async function ask(e) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    try { setAnswer((await dash(`/inbox/${id}/ask`, { method: 'POST', body: { question } })).answer); }
    catch (err) { setAnswer(err.message); }
    finally { setAsking(false); }
  }
  async function addNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    try { await dash(`/inbox/${id}/notes`, { method: 'POST', body: { text: note } }); setNote(''); reload(); } catch (err) { toast(err.message, 'red'); }
  }
  async function addTag() {
    // eslint-disable-next-line no-alert
    const tag = window.prompt(t('inbox.tagPrompt'));
    if (tag) await act('tags', { tag });
  }

  return (
    <aside className="ib-panel" aria-label={t('inbox.customer')}>
      {cu && (
        <div className="ai-summary">
          <span className="small strong-accent">{t('inbox.aiSummary')}</span>
          <p className="bn-ok">{cu.summary}</p>
          <form onSubmit={ask}>
            <input className="input input-sm" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('inbox.askAbout')} aria-label={t('inbox.askAbout')} disabled={asking} />
          </form>
          {answer && <p className="small ai-answer bn-ok" role="status">{answer}</p>}
        </div>
      )}
      {cu && (
        <section>
          <h3>{t('inbox.deliveryRecord')}</h3>
          <div className="row">
            <strong className="big-num">{cu.record.rate === null ? '—' : t.pct(cu.record.rate)}</strong>
            {cu.record.rate !== null && <Pill tone={cu.record.rate >= 80 ? 'green' : cu.record.rate >= 60 ? 'yellow' : 'red'}>{t(cu.record.rate >= 80 ? 'inbox.lowRisk' : cu.record.rate >= 60 ? 'inbox.mediumRisk' : 'inbox.highRisk')}</Pill>}
          </div>
          <p className="small muted">{t('inbox.yourShop', { orders: cu.record.orders, delivered: cu.record.delivered, returned: cu.record.returned })}</p>
          {cu.courierCheck && <p className="small muted">{t('inbox.allCouriers', { d: cu.courierCheck.delivered, n: cu.courierCheck.total })}</p>}
        </section>
      )}
      <section>
        <div className="row"><h3 className="grow">{t('inbox.orders')}</h3>{can('edit_orders') && <button type="button" className="btn btn-link small" onClick={() => navigate(`/orders/new?conversation=${id}`)}>+ {t('inbox.create')}</button>}</div>
        {data.orders.length ? (
          <ul className="mini-orders">
            {data.orders.map((o) => (
              <li key={o.id}><button type="button" className="btn-link-row" onClick={() => navigate(`/orders/${o.number}`)}>
                <span>#{o.number} · {o.item}</span><Pill tone={o.status === 'delivered' ? 'green' : o.status === 'cancelled' ? 'red' : 'blue'}>{t(`status.${o.status}`)}</Pill>
              </button></li>
            ))}
          </ul>
        ) : <p className="small muted">{t('inbox.noOrders')}</p>}
      </section>
      <section>
        <h3>{t('inbox.teamNote')}</h3>
        {data.notes.slice(0, 3).map((n) => <p key={n.id} className="team-note bn-ok">{n.text}{n.by && <> — {n.by}</>}</p>)}
        <form onSubmit={addNote}><input className="input input-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('inbox.addNote')} aria-label={t('inbox.addNote')} /></form>
      </section>
      <section>
        <h3>{t('inbox.tags')}</h3>
        <div className="chips">
          {c.tags.map((tag) => <span key={tag} className="pill pill-gray tag">{tag}<button type="button" aria-label={t('inbox.removeTag', { tag })} onClick={() => act('tags', { tag, remove: true })}>×</button></span>)}
          <button type="button" className="chip chip-sm chip-add" onClick={addTag}>+ {t('inbox.tag')}</button>
        </div>
      </section>
      {cu && (
        <section className="row ai-toggle">
          <span className="grow"><strong className="small">{t('inbox.aiForCustomer')}</strong>{cu.aiOff && cu.aiOffReason && <small className="muted"><br />{cu.aiOffReason}</small>}</span>
          <Toggle checked={!cu.aiOff} label={t('inbox.aiForCustomer')} onChange={(on) => {
            // eslint-disable-next-line no-alert
            const reason = on ? '' : window.prompt(t('inbox.aiOffWhy')) ?? '';
            act('ai', { on, reason });
          }} />
        </section>
      )}
    </aside>
  );
}

// ----------------------------------------------- Assign popup (frame 15) ----

export function AssignPopup({ t, ids, conversation, onClose, onDone }) {
  const [team, setTeam] = useState(null);
  const [pick, setPick] = useState(null);
  const [keepAi, setKeepAi] = useState(true);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { dash('/team/members').then((m) => { setTeam(m); setPick(m.find((u) => !u.you && u.onDuty)?.id ?? m[0]?.id); }).catch((err) => toast(err.message, 'red')); }, []);
  const you = team?.find((u) => u.you);
  const chosen = team?.find((u) => u.id === pick);
  const shown = useMemo(() => (team ?? []).filter((u) => u.name.toLowerCase().includes(q.toLowerCase())), [team, q]);

  async function assign(userId) {
    setBusy(true);
    try {
      if (ids.length > 1 || !conversation) await dash('/inbox/bulk', { method: 'POST', body: { ids, action: 'assign', userId } });
      else await dash(`/inbox/${ids[0]}/assign`, { method: 'POST', body: { userId, keepAi, note } });
      toast(t('inbox.assignedTo', { name: team.find((u) => u.id === userId)?.name }));
      onDone();
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }

  return (
    <Modal title={t('inbox.assignTitle')} subtitle={conversation ? `${conversation.name} · ${conversation.preview?.slice(0, 60) ?? ''}` : t('inbox.selected', { n: ids.length })} onClose={onClose} width={440}
      footer={<>
        {you && <Button onClick={() => assign(you.id)} busy={busy} className="mr-auto">{t('inbox.assignMe')}</Button>}
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={() => assign(pick)} disabled={!pick} busy={busy}>{t('inbox.assignTo', { name: chosen?.name ?? '' })}</Button>
      </>}>
      <div className="ib-search modal-search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('inbox.searchTeam')} aria-label={t('inbox.searchTeam')} /></div>
      {!team ? <Skeleton h={120} /> : (
        <ul className="team-pick" role="radiogroup" aria-label={t('inbox.assignTitle')}>
          {shown.map((u) => (
            <li key={u.id}>
              <label className={`team-row${pick === u.id ? ' on' : ''}`}>
                <span className="team-avatar"><Avatar name={u.name} size={34} /><span className={`dot ${u.onDuty ? '' : 'gray'}`} /></span>
                <span className="grow"><strong>{u.name}{u.you && ` (${t('inbox.you')})`}</strong><small className="muted">{t(`role.${u.role}`)} · {u.onDuty ? t('inbox.online') : t('shell.offDuty')}</small></span>
                <Pill tone={u.openChats > 6 ? 'orange' : u.openChats ? 'gray' : 'gray'}>{u.openChats ? t('inbox.openChats', { n: u.openChats }) : t('inbox.noChats')}</Pill>
                <input type="radio" name="assignee" checked={pick === u.id} onChange={() => setPick(u.id)} />
              </label>
            </li>
          ))}
        </ul>
      )}
      {conversation && (
        <div className="assign-extra">
          <Checkbox checked={keepAi} onChange={setKeepAi} label={t('inbox.keepAi', { name: chosen?.name ?? '' })} hint={t('inbox.keepAiHint')} />
          <input className="input input-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('inbox.assignNote')} aria-label={t('inbox.assignNote')} />
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------ Snooze popup (INB-04) ----

function SnoozePopup({ t, id, name, onClose, onDone }) {
  const now = new Date();
  const at = (h, m = 0, addDays = 0) => {
    // A time in Dhaka (UTC+6), as a Date.
    const d = new Date(now.getTime() + 6 * 3_600_000);
    d.setUTCDate(d.getUTCDate() + addDays);
    d.setUTCHours(h - 6, m, 0, 0);
    return d;
  };
  const tonight = at(23, 30);
  const options = [
    { key: '1h', icon: 'bell', at: new Date(now.getTime() + 3_600_000) },
    { key: 'tonight', icon: 'moon', at: tonight > now ? tonight : at(23, 30, 1) },
    { key: 'morning', icon: 'sparkle', at: at(10, 0, 1) },
    { key: 'week', icon: 'overview', at: at(10, 0, 7 - ((new Date(now.getTime() + 6 * 3_600_000).getUTCDay() + 6) % 7)) },
  ];
  const [choice, setChoice] = useState('morning');
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const until = choice === 'custom' ? (custom ? new Date(custom) : null) : options.find((o) => o.key === choice).at;

  async function save() {
    setBusy(true);
    try {
      await dash(`/inbox/${id}/snooze`, { method: 'POST', body: { until, note } });
      toast(t('inbox.snoozed', { time: t.dateTime(until) }));
      onDone();
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }

  return (
    <Modal title={t('inbox.snoozeTitle')} subtitle={t('inbox.snoozeSub', { name })} onClose={onClose} width={420}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} busy={busy} disabled={!until}>{until ? t('inbox.snoozeUntil', { time: t.dateTime(until) }) : t('inbox.later')}</Button></>}>
      <ul className="snooze-list" role="radiogroup">
        {options.map((o) => (
          <li key={o.key}><button type="button" role="radio" aria-checked={choice === o.key} className={choice === o.key ? 'on' : ''} onClick={() => setChoice(o.key)}>
            <Icon name={o.icon} size={15} /><span className="grow">{t(`inbox.snooze.${o.key}`)}</span><span className="muted small">{t.dateTime(o.at)}</span>
          </button></li>
        ))}
        <li><button type="button" role="radio" aria-checked={choice === 'custom'} className={choice === 'custom' ? 'on' : ''} onClick={() => setChoice('custom')}>
          <Icon name="edit" size={15} /><span className="grow">{t('inbox.snooze.custom')}</span>
        </button></li>
      </ul>
      {choice === 'custom' && <input className="input" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={t('inbox.snooze.custom')} />}
      <input className="input" style={{ marginTop: 10 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('inbox.snoozeNote')} aria-label={t('inbox.snoozeNote')} />
    </Modal>
  );
}
