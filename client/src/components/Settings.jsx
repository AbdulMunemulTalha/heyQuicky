import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { PLATFORM_LABEL } from '../format.js';
import { AiSettings } from './AiSettings.jsx';
import { FacebookButton, ImportStatus, Modal, WhatsAppButton, useConnect, useSocketEvent } from './common.jsx';

// The owner's settings: team, connected channels, delivery charges and saved replies.
export function Settings({ open, onClose, me, setMe, team, reloadTeam, savedReplies, reloadSavedReplies, reloadConversations }) {
  const { result, resultVersion, showResult } = useConnect();
  const [channels, setChannels] = useState([]);
  const [memberResult, setMemberResult] = useState('');
  const { facebook, whatsapp } = me.connect;

  const loadChannels = useCallback(() => api('/channels').then(setChannels).catch(() => {}), []);
  useEffect(() => { if (open) { loadChannels(); reloadTeam(); } }, [open, loadChannels, reloadTeam]);
  // A connection finished or an import moved on.
  useEffect(() => { if (resultVersion) loadChannels(); }, [resultVersion, loadChannels]);
  useSocketEvent('channels', () => { if (open) loadChannels(); });

  const submitForm = (handler) => async (e) => {
    e.preventDefault();
    try {
      await handler(e.target, Object.fromEntries(new FormData(e.target)));
    } catch (err) {
      alert(err.message);
    }
  };

  const addMember = submitForm(async (form, body) => {
    const { user, password } = await api('/team', { method: 'POST', body });
    setMemberResult(`${user.name} can sign in with ${user.email} / ${password}`);
    form.reset();
    reloadTeam();
  });

  async function toggleMember(m) {
    await api(`/team/${m.id}`, { method: 'PATCH', body: { isActive: !m.isActive } });
    await reloadTeam();
    reloadConversations();
  }

  async function importChannel(c) {
    try {
      await api(`/channels/${c.id}/import`, { method: 'POST' });
      loadChannels();
    } catch (err) {
      alert(err.message);
    }
  }

  async function disconnect(c) {
    if (!window.confirm(`Disconnect ${c.name}? Its conversations will be deleted.`)) return;
    await api(`/channels/${c.id}`, { method: 'DELETE' });
    loadChannels();
    reloadConversations();
  }

  const addChannel = submitForm(async (form, body) => {
    const channel = await api('/channels', { method: 'POST', body });
    form.reset();
    showResult({ connected: [channel.name] });
  });

  const saveDelivery = submitForm(async (_form, body) => {
    const workspace = await api('/workspace', {
      method: 'PATCH', body: { deliveryInsideDhaka: Number(body.deliveryInsideDhaka), deliveryOutsideDhaka: Number(body.deliveryOutsideDhaka) },
    });
    setMe((m) => ({ ...m, workspace }));
  });

  const addSaved = submitForm(async (form, body) => {
    await api('/saved-replies', { method: 'POST', body });
    form.reset();
    reloadSavedReplies();
  });

  async function deleteSaved(r) {
    await api(`/saved-replies/${r.id}`, { method: 'DELETE' });
    reloadSavedReplies();
  }

  const simulate = submitForm(async (_form, body) => {
    await api('/dev/simulate', { method: 'POST', body });
  });

  return (
    <Modal open={open} onClose={onClose}>
      <AiSettings me={me} setMe={setMe} open={open} />

      <h2>Team</h2>
      <table className="table">
        <tbody>
          {team.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td className="muted">{m.email}</td>
              <td>{m.role}</td>
              <td>{m.isActive ? (m.isOnline ? 'On duty' : 'Off duty') : 'Removed'}</td>
              <td>{m.openCount} open</td>
              <td>{m.role === 'moderator' && <button className="ghost" onClick={() => toggleMember(m)}>{m.isActive ? 'Remove' : 'Restore'}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="inline-form" onSubmit={addMember}>
        <input name="name" placeholder="Moderator name" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" placeholder="Password (optional)" />
        <button>Add moderator</button>
      </form>
      <p className="muted small">{memberResult}</p>

      <h2>Connected channels</h2>
      <table className="table">
        <tbody>
          {channels.map((c) => (
            <tr key={c.id}>
              <td><span className={`badge ${c.platform}`}>{PLATFORM_LABEL[c.platform]}</span></td>
              <td>{c.name}</td>
              <td className="muted">{c.externalId}</td>
              <td>
                {c.needsReconnect
                  ? <span className="warn">Facebook access expired: connect again</span>
                  : c.connected ? 'Live' : 'Test mode (no token)'}
                <ImportStatus channel={c} />
              </td>
              <td>
                {['messenger', 'instagram'].includes(c.platform) && c.connected && c.importStatus !== 'running' && (
                  <button className="ghost" title="Copy in conversations from before this account was connected" onClick={() => importChannel(c)}>
                    {c.importStatus ? 'Import again' : 'Import past chats'}
                  </button>
                )}
              </td>
              <td><button className="ghost" onClick={() => disconnect(c)}>Disconnect</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="connect-buttons">
        {facebook && <FacebookButton>Connect Facebook Page &amp; Instagram</FacebookButton>}
        {whatsapp && (
          <>
            <WhatsAppButton mode="app" className="brand-whatsapp">Connect WhatsApp Business app</WhatsAppButton>
            <WhatsAppButton mode="new" className="ghost">WhatsApp with a new number</WhatsAppButton>
          </>
        )}
      </div>
      {!(facebook && whatsapp) && (
        <p className="muted small">
          One-click connection needs the server's Meta app settings (META_APP_ID, META_APP_SECRET and, for WhatsApp,
          META_WHATSAPP_CONFIG_ID). You can still connect manually below.
        </p>
      )}
      {result && <p className="notice">{result}</p>}
      <details className="manual-connect">
        <summary className="muted small">Connect manually with an ID and access token (advanced)</summary>
        <form className="inline-form" onSubmit={addChannel}>
          <select name="platform">
            <option value="messenger">Facebook Page</option>
            <option value="instagram">Instagram</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <input name="name" placeholder="Display name" required />
          <input name="externalId" placeholder="Page ID / IG account ID / WA phone number ID" required />
          <input name="accessToken" placeholder="Access token (blank = test mode)" />
          <button>Connect</button>
        </form>
      </details>

      <h2>Delivery charges</h2>
      <form className="inline-form" onSubmit={saveDelivery}>
        <label className="field">Inside Dhaka (৳)<input name="deliveryInsideDhaka" type="number" min="0" step="1" required defaultValue={me.workspace.deliveryInsideDhaka} /></label>
        <label className="field">Outside Dhaka (৳)<input name="deliveryOutsideDhaka" type="number" min="0" step="1" required defaultValue={me.workspace.deliveryOutsideDhaka} /></label>
        <button>Save</button>
      </form>

      <h2>Saved replies</h2>
      <p className="muted small">Moderators type / and the shortcut in the reply box, e.g. <code>/price</code>.</p>
      <table className="table">
        <tbody>
          {savedReplies.map((r) => (
            <tr key={r.id}>
              <td><code>/{r.shortcut}</code></td>
              <td>{r.text}</td>
              <td><button className="ghost" onClick={() => deleteSaved(r)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="inline-form" onSubmit={addSaved}>
        <input name="shortcut" placeholder="Shortcut, e.g. bkash" required style={{ maxWidth: 180 }} />
        <textarea name="text" rows={2} placeholder="Reply text" required />
        <button>Save reply</button>
      </form>

      {me.devTools && (
        <div>
          <h2>Test a customer message</h2>
          <p className="muted small">Development only. Pretends a customer messaged one of your channels.</p>
          <form className="inline-form" onSubmit={simulate}>
            <select name="channelId">
              {channels.map((c) => <option key={c.id} value={String(c.id)}>{PLATFORM_LABEL[c.platform]} · {c.name}</option>)}
            </select>
            <input name="customerId" placeholder="Customer ID" defaultValue="cust-1" required />
            <input name="customerName" placeholder="Customer name" defaultValue="Rahim" />
            <input name="text" placeholder="Message" defaultValue="Ei dress ta koto taka?" required />
            <button>Send as customer</button>
          </form>
        </div>
      )}
    </Modal>
  );
}
