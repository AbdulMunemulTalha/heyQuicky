import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { PLATFORM_LABEL, STATUS_LABEL, customerLabel, initials, taka, timeLabel, windowNotice } from '../format.js';
import { Avatar, useSocketEvent } from './common.jsx';
import { OrderDialog } from './OrderDialog.jsx';
import { OrdersDialog } from './OrdersDialog.jsx';
import { Settings } from './Settings.jsx';

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 6h-2v9H6v2c0 .6.4 1 1 1h11l4 4V7c0-.6-.4-1-1-1zm-4 6V3c0-.6-.4-1-1-1H3c-.6 0-1 .4-1 1v14l4-4h10c.6 0 1-.4 1-1z" /></svg>
);

export function Inbox({ me, setMe, onSignOut, settingsOpen, setSettingsOpen }) {
  const isOwner = me.user.role === 'owner';
  const myId = me.user.id;
  const [team, setTeam] = useState([]);
  // Owners oversee everything, and a shop without moderators has nothing under "Mine".
  const [filter, setFilter] = useState(isOwner ? 'all' : 'mine');
  const [platform, setPlatform] = useState('');
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState(() => new Map());
  // Open conversations nobody has picked up yet, shown as a count on the tab.
  const [waiting, setWaiting] = useState(() => new Set());
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [savedReplies, setSavedReplies] = useState([]);
  const [conversationOrders, setConversationOrders] = useState([]);
  const [online, setOnline] = useState(me.user.isOnline);
  const [orderDialogOpen, setOrderDialogOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const searchRef = useRef(null);
  const activeRef = useRef(null);
  activeRef.current = activeId;

  const loadTeam = useCallback(() => api('/team').then(setTeam), []);
  const loadSavedReplies = useCallback(() => api('/saved-replies').then(setSavedReplies), []);

  const loadConversations = useCallback(async () => {
    const [rows, unassigned] = await Promise.all([
      api(`/conversations?filter=${filter}`),
      api('/conversations?filter=unassigned&status=open'),
    ]);
    setConversations(new Map(rows.map((c) => [c.id, c])));
    setWaiting(new Set(unassigned.map((c) => c.id)));
  }, [filter]);

  const loadConversationOrders = useCallback(async (id) => {
    const { orders } = await api(`/conversations/${id}/orders`);
    if (id === activeRef.current) setConversationOrders(orders);
  }, []);

  useEffect(() => { loadTeam(); loadSavedReplies(); }, [loadTeam, loadSavedReplies]);
  useEffect(() => { loadConversations().catch(() => {}); }, [loadConversations]);

  const markRead = (id) => api(`/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
  const canMarkRead = (c) => c && (c.assigned_user_id === myId || isOwner);

  // ---- Real-time updates ----
  useSocketEvent('conversation', (c) => {
    setConversations((prev) => {
      const next = new Map(prev);
      if (!isOwner && c.assigned_user_id !== null && c.assigned_user_id !== myId) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });
    setWaiting((prev) => {
      const next = new Set(prev);
      if (c.status === 'open' && c.assigned_user_id === null) next.add(c.id);
      else next.delete(c.id);
      return next;
    });
  });
  useSocketEvent('message', ({ conversationId, message }) => {
    if (conversationId !== activeRef.current) return;
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === message.id);
      if (i < 0) return [...prev, message];
      const next = [...prev];
      next[i] = message;
      return next;
    });
    if (message.direction === 'in' && !document.hidden && canMarkRead(conversations.get(conversationId))) markRead(conversationId);
  });
  // Past conversations arrived (Facebook/Instagram import or WhatsApp history sync).
  useSocketEvent('imported', () => loadConversations().catch(() => {}));
  useSocketEvent('connect', () => loadConversations().catch(() => {}));
  useSocketEvent('order', (order) => {
    if (order.conversation_id === activeRef.current) loadConversationOrders(order.conversation_id);
  });

  // Ctrl+E focuses the search box.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function openConversation(id) {
    setActiveId(id);
    activeRef.current = id;
    setMessages([]);
    setConversationOrders([]);
    const [msgs] = await Promise.all([api(`/conversations/${id}/messages`), loadConversationOrders(id)]);
    if (activeRef.current === id) setMessages(msgs);
    const c = conversations.get(id);
    if (c?.unread_count && canMarkRead(c)) markRead(id);
  }

  async function setDuty(value) {
    setOnline(value);
    try {
      const { assigned } = await api('/me/duty', { method: 'POST', body: { online: value } });
      if (assigned) loadConversations();
      loadTeam();
    } catch (err) {
      setOnline(!value);
      alert(err.message);
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    onSignOut();
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...conversations.values()]
      .filter((c) => {
        if (platform && c.platform !== platform) return false;
        if (q) {
          const label = customerLabel(c);
          const haystack = `${label.title} ${label.subtitle} ${c.contact_name || ''} ${c.last_message_preview || ''}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        if (filter === 'mine') return c.assigned_user_id === myId;
        if (filter === 'unassigned') return c.assigned_user_id === null;
        return true;
      })
      .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
  }, [conversations, platform, search, filter, myId]);

  const active = activeId !== null ? conversations.get(activeId) : null;

  return (
    <section className="app">
      <aside className="sidebar">
        <header className="side-head">
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
          <strong>Active chats</strong>
        </header>
        <div className="search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" /></svg>
          <input ref={searchRef} type="search" placeholder="Search" autoComplete="off" aria-label="Search chats"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <kbd>Ctrl + E</kbd>
        </div>
        <ul className="conversation-list">
          {visible.map((c) => {
            const label = customerLabel(c);
            return (
              <li key={c.id} className={`${c.id === activeId ? 'active' : ''} ${c.unread_count ? 'has-unread' : ''}`} onClick={() => openConversation(c.id)}>
                <Avatar conversation={c} />
                <div className="conv-body">
                  <div className="row">
                    <span className="name">{label.title}{label.subtitle && <span className="muted name-extra"> · {label.subtitle}</span>}</span>
                    <span className="time">{timeLabel(c.last_message_at)}</span>
                  </div>
                  <div className="row">
                    <span className="preview">{c.last_message_preview || ' '}</span>
                    {c.unread_count > 0 && <span className="unread">{c.unread_count}</span>}
                  </div>
                  {filter !== 'mine' && (
                    <div className="handler">{c.assigned_user_name ? `Handled by ${c.assigned_user_name}` : 'Waiting for a moderator'}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {visible.length === 0 && (
          <div className="list-empty"><ChatIcon /><span>{search ? 'No chats match your search' : 'No chats yet'}</span></div>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <nav className="pills">
            <button className={filter === 'mine' ? 'active' : ''} onClick={() => setFilter('mine')}>Mine</button>
            <button className={filter === 'unassigned' ? 'active' : ''} onClick={() => setFilter('unassigned')}>
              Unassigned{waiting.size > 0 && <span className="unread tab-count">{waiting.size}</span>}
            </button>
            {isOwner && <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>}
          </nav>
          <label className="channel-filter">
            <span className={`channel-dot ${platform}`} aria-hidden="true" />
            <select aria-label="Channel" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">All channels</option>
              {Object.entries(PLATFORM_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <span className="spacer" />
          <label className="switch" title="New customers are only given to moderators who are on duty">
            <input type="checkbox" checked={online} onChange={(e) => setDuty(e.target.checked)} /><span className="track" /><span>On duty</span>
          </label>
          <button className="ghost" onClick={() => setOrdersOpen(true)}>Orders</button>
          {isOwner && <button className="ghost" onClick={() => setSettingsOpen(true)}>Settings</button>}
          <details className="user-menu">
            <summary><span className="avatar small">{initials(me.user.name) || '?'}</span></summary>
            <div className="menu">
              <strong>{me.user.name} ({me.user.role})</strong>
              <span className="muted small">{me.workspace.name}</span>
              <button className="ghost" onClick={logout}>Sign out</button>
            </div>
          </details>
        </header>

        <section className="chat">
          {active ? (
            <Chat
              key={active.id}
              me={me}
              conversation={active}
              team={team}
              messages={messages}
              orders={conversationOrders}
              savedReplies={savedReplies}
              onNewOrder={() => setOrderDialogOpen(true)}
            />
          ) : (
            <div className="empty-state">
              <ChatIcon />
              <h2>{visible.length ? 'No chat selected' : 'No threads here yet'}</h2>
              <p>{visible.length ? 'Pick a chat from the list to read and reply.' : 'You have no conversations yet in this section'}</p>
            </div>
          )}
        </section>
      </main>

      <OrderDialog open={orderDialogOpen && Boolean(active)} conversationId={activeId} workspace={me.workspace} onClose={() => setOrderDialogOpen(false)} />
      <OrdersDialog open={ordersOpen} onClose={() => setOrdersOpen(false)} />
      {isOwner && (
        <Settings
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          me={me}
          setMe={setMe}
          team={team}
          reloadTeam={loadTeam}
          savedReplies={savedReplies}
          reloadSavedReplies={loadSavedReplies}
          reloadConversations={loadConversations}
        />
      )}
    </section>
  );
}

function Chat({ me, conversation: c, team, messages, orders, savedReplies, onNewOrder }) {
  const isOwner = me.user.role === 'owner';
  const canReply = isOwner || c.assigned_user_id === null || c.assigned_user_id === me.user.id;
  const label = customerLabel(c);
  const notices = [];
  if (!canReply) notices.push(`${c.assigned_user_name} is handling this customer. Only they or the owner can reply.`);
  const w = windowNotice(c);
  if (w) notices.push(w);

  async function assign(e) {
    const userId = e.target.value ? Number(e.target.value) : null;
    try {
      await api(`/conversations/${c.id}/assign`, { method: 'POST', body: { userId } });
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="chat-inner">
      <header className="chat-header">
        <Avatar conversation={c} />
        <div className="chat-who">
          <div className="chat-title">{label.subtitle ? `${label.title} · ${label.subtitle}` : label.title}</div>
          <div className="muted small">
            {`${PLATFORM_LABEL[c.platform]} · ${c.channel_name} · ${c.assigned_user_name ? `Handled by ${c.assigned_user_name}` : 'Unassigned'}`}
          </div>
        </div>
        <span className="spacer" />
        {isOwner && (
          <select aria-label="Assigned to" value={c.assigned_user_id ? String(c.assigned_user_id) : ''} onChange={assign}>
            <option value="">Unassigned</option>
            {team.filter((m) => m.isActive).map((m) => (
              <option key={m.id} value={String(m.id)}>{m.name}{m.role === 'owner' ? ' (owner)' : ''}</option>
            ))}
          </select>
        )}
        {canReply && <button onClick={onNewOrder}>New order</button>}
      </header>
      {orders.length > 0 && (
        <div className="order-strip">
          <span className="muted">Orders:</span>
          {orders.map((o) => (
            <span className="order-chip" key={o.id}>
              #{o.id} · {taka(o.cod_amount)} COD · <span className={`status-${o.status}`}>{STATUS_LABEL[o.status]}</span>
            </span>
          ))}
        </div>
      )}
      <Messages messages={messages} team={team} />
      {notices.length > 0 && <p className="notice">{notices.join(' ')}</p>}
      {canReply && <Composer conversationId={c.id} savedReplies={savedReplies} />}
    </div>
  );
}

function Messages({ messages, team }) {
  const box = useRef(null);
  const first = useRef(true);
  // Stay pinned to the newest message unless the reader scrolled up.
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (first.current || atBottom.current) el.scrollTop = el.scrollHeight;
    if (messages.length) first.current = false;
  }, [messages]);
  const names = new Map(team.map((t) => [t.id, t.name]));
  return (
    <div className="messages" ref={box} onScroll={(e) => {
      const el = e.currentTarget;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }}>
      {messages.map((m) => {
        const sender = m.direction === 'out' && m.sender_user_id ? names.get(m.sender_user_id) : null;
        const status = m.direction === 'out' ? ` · ${m.status}${m.error ? `: ${m.error}` : ''}` : '';
        return (
          <div key={m.id} className={`bubble ${m.direction} ${m.status === 'failed' ? 'failed' : ''}`}>
            {m.text || null}
            {m.attachments.map((a, i) => (
              <div key={i}>{a.url ? <a href={a.url} target="_blank" rel="noopener noreferrer">[{a.type}]</a> : `[${a.type}]`}</div>
            ))}
            <div className="meta">{`${sender ? `${sender} · ` : ''}${timeLabel(m.created_at)}${status}`}</div>
          </div>
        );
      })}
    </div>
  );
}

// The reply box. Typing "/" opens the saved replies picker.
function Composer({ conversationId, savedReplies }) {
  const [text, setText] = useState('');
  const [pickIndex, setPickIndex] = useState(0);
  const [pickerClosed, setPickerClosed] = useState(false);
  const input = useRef(null);

  const shortcut = /^\/(\S*)$/.exec(text);
  const matches = shortcut && !pickerClosed
    ? savedReplies.filter((r) => r.shortcut.startsWith(shortcut[1].toLowerCase())).slice(0, 8)
    : [];

  useLayoutEffect(() => {
    const box = input.current;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }, [text]);

  function change(value) {
    setText(value);
    setPickIndex(0);
    setPickerClosed(false);
  }

  function pickReply(reply) {
    setText(reply.text);
    input.current.focus();
  }

  async function send(e) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      await api(`/conversations/${conversationId}/messages`, { method: 'POST', body: { text: body } });
    } catch (err) {
      setText(body);
      alert(err.message);
    }
  }

  function keyDown(e) {
    if (matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPickIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickReply(matches[pickIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPickerClosed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      {matches.length > 0 && (
        <ul className="saved-picker">
          {matches.map((r, i) => (
            <li key={r.id} className={i === pickIndex ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); pickReply(r); }}>
              <strong>/{r.shortcut}</strong>{`  ${r.text}`}
            </li>
          ))}
        </ul>
      )}
      <form className="composer" onSubmit={send}>
        <textarea ref={input} rows={1} placeholder="Write a reply…  ( / for saved replies )" value={text}
          onChange={(e) => change(e.target.value)} onKeyDown={keyDown} />
        <button type="submit" className="send" aria-label="Send">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21 23 12 2 3v7l15 2-15 2z" /></svg>
        </button>
      </form>
    </>
  );
}

