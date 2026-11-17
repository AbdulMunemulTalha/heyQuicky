import { useCallback, useEffect, useRef, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Card, Checkbox, Empty, ErrorState, Pill, Skeleton, toast } from '../ui/kit.jsx';
import './saved.css';

const BLANK = { name: '', shortcut: '', text: '', scope: 'team', folder: '', blocks: [], phrases: [], autoAnswer: true, pinned: false };

// Screen 06: saved replies — shortcuts, rich blocks, auto-answers with phrase matching, impact preview.
export default function SavedReplies() {
  const t = useT();
  const { can } = useDash();
  const [lib, setLib] = useState(null);
  const [error, setError] = useState(null);
  const [folder, setFolder] = useState('');
  const [selected, setSelected] = useState(null); // id or 'new'
  const load = useCallback(() => dash('/saved-replies/library').then((d) => { setLib(d); setSelected((s) => s ?? d.items[0]?.id ?? 'new'); }, setError), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState thing={t('nav.saved')} error={error} onRetry={load} />;
  const items = (lib?.items ?? []).filter((r) => !folder || r.folder === folder);
  const current = selected === 'new' ? BLANK : lib?.items.find((r) => r.id === selected);
  return (
    <div className="saved">
      <header className="page-head">
        <div><h1>{t('nav.saved')}</h1><p className="page-sub">{t('sr.sub')}</p></div>
        <div className="page-actions">
          {lib && <Pill tone="green" className="sr-free">{t('sr.answeredFree', { n: t.num(lib.answeredWeek) })}</Pill>}
          {can('reply') && <Button variant="primary" icon="plus" onClick={() => setSelected('new')}>{t('sr.new')}</Button>}
        </div>
      </header>
      <div className="sr-grid">
        <Card pad={false} className="sr-list">
          <div className="chips sr-folders">
            <button type="button" className={`chip${!folder ? ' on' : ''}`} onClick={() => setFolder('')}>{t('common.all')} <span className="chip-count">{t.num(lib?.items.length ?? 0)}</span></button>
            {(lib?.folders ?? []).map((f) => <button key={f} type="button" className={`chip${folder === f ? ' on' : ''}`} onClick={() => setFolder(f)}>{f}</button>)}
          </div>
          {!lib ? <div className="pad"><Skeleton h={160} /></div> : items.length === 0 ? <Empty icon="saved" title={t('sr.empty')}>{t('sr.emptySub')}</Empty> : (
            <ul>
              {items.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`sr-item${selected === r.id ? ' on' : ''}`} onClick={() => setSelected(r.id)}>
                    <span className="row"><strong className="grow">{r.pinned && '📌 '}{r.name}</strong><code>{r.shortcut}</code></span>
                    <span className="row small muted">{r.autoAnswer && <Pill tone="green">{t('sr.auto')}</Pill>}{r.scope === 'private' && <Pill>{t('sr.private')}</Pill>}{t('sr.sent', { n: t.num(r.uses) })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {current ? <Editor key={selected} t={t} reply={current} isNew={selected === 'new'} folders={lib?.folders ?? []}
          onSaved={(id) => { setSelected(id); load(); }} onDeleted={() => { setSelected(null); load(); }} onCancel={() => setSelected(lib?.items[0]?.id ?? 'new')} /> : <Card><Skeleton h={300} /></Card>}
      </div>
    </div>
  );
}

function Editor({ t, reply, isNew, folders, onSaved, onDeleted, onCancel }) {
  const { can } = useDash();
  const [r, setR] = useState({ ...reply, phrases: [...reply.phrases], blocks: [...reply.blocks] });
  const [phrase, setPhrase] = useState('');
  const [impact, setImpact] = useState(null);
  const [found, setFound] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState(null);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef(null);
  const uploadType = useRef('photo');
  const set = (k, v) => setR((x) => ({ ...x, [k]: v }));

  // Impact preview and phrase discovery follow the phrases as they change.
  useEffect(() => {
    const timer = setTimeout(() => {
      dash('/saved-replies/impact', { method: 'POST', body: { phrases: r.phrases } }).then(setImpact).catch(() => {});
      dash('/saved-replies/discover', { method: 'POST', body: { phrases: r.phrases, name: r.name } }).then(setFound).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [r.phrases, r.name]);
  useEffect(() => {
    const timer = setTimeout(() => dash('/saved-replies/check', { method: 'POST', body: { text: [r.text, ...r.blocks.map((b) => b.text)].join(' ') } }).then((x) => setWarnings(x.warnings)).catch(() => {}), 400);
    return () => clearTimeout(timer);
  }, [r.text, r.blocks]);

  function addPhrase(p) {
    const v = (p ?? phrase).trim();
    if (!v || r.phrases.includes(v)) return;
    set('phrases', [...r.phrases, v]);
    setPhrase('');
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast(t('sr.tooBig'), 'red'); return; }
    try {
      const res = await fetch('/api/dash/uploads', { method: 'POST', headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name), authorization: `Bearer ${session.token}` }, body: file });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      set('blocks', [...r.blocks, { type: uploadType.current, url: d.url, label: file.name }]);
    } catch (err) { toast(err.message, 'red'); }
  }

  function addBlock(type) {
    if (type === 'photo' || type === 'voice') {
      uploadType.current = type;
      fileInput.current.accept = type === 'photo' ? 'image/*' : 'audio/*';
      fileInput.current.click();
      return;
    }
    if (type === 'product') {
      setPicking(true);
      if (!products) dash('/orders/products').then(setProducts).catch(() => setProducts([]));
      return;
    }
    if (type === 'blank') { set('text', `${r.text}{name}`); return; }
    set('blocks', [...r.blocks, { type: 'message', text: '' }]);
  }

  async function save() {
    setBusy(true);
    try {
      const body = { name: r.name, shortcut: r.shortcut, text: r.text, scope: r.scope, folder: r.folder, blocks: r.blocks, phrases: r.phrases, autoAnswer: r.autoAnswer, pinned: r.pinned };
      const saved = isNew ? await dash('/saved-replies/library', { method: 'POST', body }) : await dash(`/saved-replies/library/${reply.id}`, { method: 'PATCH', body });
      toast(t('sr.savedOk'), 'green');
      onSaved(saved.id);
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(false); }
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('sr.confirmDelete', { s: reply.shortcut }))) return;
    try { await dash(`/saved-replies/library/${reply.id}`, { method: 'DELETE' }); toast(t('sr.deleted')); onDeleted(); } catch (err) { toast(err.message, 'red'); }
  }

  const readOnly = !can('reply');
  return (
    <Card className="sr-editor">
      <div className="sr-three">
        <div className="field"><label htmlFor="sr-name">{t('sr.name')}</label><input id="sr-name" value={r.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} maxLength={60} /></div>
        <div className="field"><label htmlFor="sr-short">{t('sr.shortcut')}</label><input id="sr-short" value={r.shortcut} placeholder="/delivery" onChange={(e) => set('shortcut', e.target.value)} disabled={readOnly} maxLength={31} /></div>
        <div className="field"><label htmlFor="sr-scope">{t('sr.who')}</label>
          <select id="sr-scope" value={r.scope} onChange={(e) => set('scope', e.target.value)} disabled={readOnly}><option value="team">{t('sr.team')}</option><option value="private">{t('sr.onlyMe')}</option></select></div>
      </div>
      <div className="field sr-mt"><label htmlFor="sr-text">{t('sr.reply')}</label>
        <textarea id="sr-text" rows={3} value={r.text} onChange={(e) => set('text', e.target.value)} disabled={readOnly} maxLength={2000} />
        {warnings.length > 0 && <p className="field-error" role="alert">{t('sr.mistake', { v: warnings[0].value, n: warnings[0].digits })}</p>}
      </div>
      {r.blocks.length > 0 && (
        <ul className="sr-blocks">
          {r.blocks.map((b, i) => (
            <li key={i}>
              <Pill tone="blue">{t(`sr.block.${b.type}`)}</Pill>
              {b.type === 'message' ? <input className="input input-sm grow" value={b.text} placeholder={t('sr.extraMessage')} onChange={(e) => set('blocks', r.blocks.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                : <span className="grow small">{b.type === 'photo' ? <img src={b.url} alt="" className="sr-thumb" /> : null}{b.label || b.url}</span>}
              <button type="button" className="modal-x" aria-label={t('common.delete')} onClick={() => set('blocks', r.blocks.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="sr-add">
          {['message', 'photo', 'product', 'voice', 'blank'].map((b) => <button key={b} type="button" className="btn btn-sm" onClick={() => addBlock(b)}>+ {t(`sr.block.${b}`)}</button>)}
          <input ref={fileInput} type="file" hidden onChange={upload} />
        </div>
      )}
      {picking && (
        <div className="sr-picker">
          {!products ? <Skeleton h={60} /> : products.map((p) => (
            <button key={p.id} type="button" className="gr-product" onClick={() => { set('blocks', [...r.blocks, { type: 'product', productId: p.id, label: p.name }]); setPicking(false); }}>
              <span className="od-swatch sm" style={{ background: p.colour }} /> {p.name} <span className="muted">{t.money(p.price)}</span>
            </button>
          ))}
        </div>
      )}
      <p className="small muted">{t('sr.priceNote')}</p>

      <div className="field sr-mt"><span className="label-like">{t('sr.whenWrites')}</span>
        <div className="chips">
          {r.phrases.map((p) => <span key={p} className="pill pill-gray tag bn-ok sr-phrase">{p}{!readOnly && <button type="button" aria-label={t('inbox.removeTag', { tag: p })} onClick={() => set('phrases', r.phrases.filter((x) => x !== p))}>×</button>}</span>)}
          {!readOnly && <input className="input input-sm sr-phrase-in" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={t('sr.addPhrase')}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPhrase(); } }} aria-label={t('sr.addPhrase')} />}
        </div>
        {found.length > 0 && (
          <div className="chips sr-found">
            <span className="small muted">{t('sr.found')}</span>
            {found.map((f) => <button key={f.text} type="button" className="chip chip-sm chip-found bn-ok" onClick={() => addPhrase(f.text)} title={t('sr.foundTimes', { n: f.count })}>+ {f.text}</button>)}
          </div>
        )}
        <p className="small muted">{t('sr.ignored')}</p>
      </div>

      <div className="sr-bottom">
        <div className="sr-impact"><strong>{impact ? t.num(impact.messages) : '—'}</strong><span>{t('sr.impact', { c: impact ? t.num(impact.customers) : '—' })}</span></div>
        <div className="sr-autobox">
          <Checkbox checked={r.autoAnswer} disabled={readOnly || !r.phrases.length} onChange={(v) => set('autoAnswer', v)} label={t('sr.autoAnswer')} hint={r.phrases.length ? t('sr.autoHint') : t('sr.autoNeedsPhrase')} />
        </div>
      </div>
      <div className="sr-foot">
        {!isNew && !readOnly && <Button variant="danger" onClick={remove}>{t('common.delete')}</Button>}
        <Checkbox checked={r.pinned} disabled={readOnly} onChange={(v) => set('pinned', v)} label={t('sr.pin')} />
        <input className="input input-sm sr-folder" list="sr-folders" value={r.folder} onChange={(e) => set('folder', e.target.value)} placeholder={t('sr.folder')} disabled={readOnly} aria-label={t('sr.folder')} />
        <datalist id="sr-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        <span className="grow" />
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        {!readOnly && <Button variant="dark" busy={busy} onClick={save}>{t('sr.save')}</Button>}
      </div>
    </Card>
  );
}
