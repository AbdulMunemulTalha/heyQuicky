import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorText, Modal } from './common.jsx';

// After the Facebook login, the owner ticks which Pages and Instagram accounts to connect.
export function ConnectDialog({ pendingId, onClose, onResult }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pendingId) return;
    setPages(null);
    setError('');
    api(`/connect/facebook/${encodeURIComponent(pendingId)}`)
      .then(setPages)
      .catch((err) => { onClose(); onResult({ problems: [err.message] }); });
  }, [pendingId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    const picked = (name) => [...e.target.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
    setBusy(true);
    try {
      const result = await api(`/connect/facebook/${encodeURIComponent(pendingId)}`, {
        method: 'POST', body: { messenger: picked('messenger'), instagram: picked('instagram') },
      });
      onClose();
      onResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={Boolean(pendingId && pages)} onClose={onClose} closeLabel="Cancel">
      <h2>Choose what to connect</h2>
      <p className="muted small">Messages from what you tick will arrive in this inbox. Instagram accounts appear here when they are linked to the Facebook Page.</p>
      <form onSubmit={submit}>
        <div className="connect-pages">
          {pages?.map((p) => (
            <div className="connect-page" key={p.id}>
              <strong>{p.name}</strong>
              <label>
                <input type="checkbox" name="messenger" value={p.id} defaultChecked={!p.messengerConnected} />
                <span className="badge messenger">Messenger</span>
                {p.messengerConnected ? 'Already connected (reconnect)' : 'Page messages'}
              </label>
              {p.instagram ? (
                <label>
                  <input type="checkbox" name="instagram" value={p.instagram.id} defaultChecked={!p.instagram.connected} />
                  <span className="badge instagram">Instagram</span>
                  {`${p.instagram.username ? `@${p.instagram.username}` : 'Linked account'}${p.instagram.connected ? ' · already connected (reconnect)' : ''}`}
                </label>
              ) : <span className="muted small">No Instagram account is linked to this Page.</span>}
            </div>
          ))}
        </div>
        <ErrorText>{error}</ErrorText>
        <button type="submit" disabled={busy}>Connect selected</button>
      </form>
    </Modal>
  );
}
