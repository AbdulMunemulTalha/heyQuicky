import { useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Button, Drawer, Empty, Skeleton, toast } from '../ui/kit.jsx';
import { RichMessage } from '../ui/rich.jsx';

const MAX = 10; // Messenger shows at most 10 cards in one carousel

// CAT-03 / CAT-04: pick products and send them to the customer as product cards (screen 24).
export default function SendProducts({ conversationId, onClose }) {
  const t = useT();
  const { refreshBadges } = useDash();
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      dash(`/catalog?filter=all${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((d) => setList(d.products.filter((p) => p.visibility !== 'hidden')), () => setList([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);

  const toggle = (p) => setPicked((x) => (x.some((y) => y.id === p.id) ? x.filter((y) => y.id !== p.id) : x.length >= MAX ? x : [...x, p]));
  async function send() {
    setBusy(true);
    try {
      await dash(`/inbox/${conversationId}/products`, { method: 'POST', body: { productIds: picked.map((p) => p.id) } });
      toast(t('sp.sent', { n: t.num(picked.length) }), 'green');
      refreshBadges();
      onClose();
    } catch (e) { toast(e.message, 'red'); setBusy(false); }
  }
  // Preview with the same look the customer gets.
  const preview = picked.map((p) => ({ productId: p.id, title: p.name, price: p.price, compareAt: p.compareAt, inStock: p.state !== 'out', image: p.photo, colour: p.colour, code: p.code,
    sizes: p.sizes.filter((s) => s.stock === null || s.stock > 0).map((s) => s.label), buttons: p.state === 'out' ? [{ title: t('sp.notify') }] : [{ title: t('sp.want') }] }));

  return (
    <Drawer title={t('sp.title')} onClose={onClose} width={460}
      footer={<><span className="small muted grow">{t('sp.count', { n: t.num(picked.length), max: t.num(MAX) })}</span><Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!picked.length} onClick={send}>{t('sp.send', { n: t.num(picked.length) })}</Button></>}>
      <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cat.search')} aria-label={t('cat.search')} />
      {picked.length > 0 && <div className="sp-preview"><RichMessage kind="carousel" payload={{ cards: preview }} /></div>}
      <ul className="sp-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {list === null ? <li><Skeleton h={48} /></li> : list.length === 0 ? <li><Empty icon="catalog" title={t('cat.noMatch')} /></li> : list.map((p) => {
          const on = picked.some((x) => x.id === p.id);
          return (
            <li key={p.id}>
              <label className={`sp-item${on ? ' on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(p)} disabled={!on && picked.length >= MAX} aria-label={p.name} />
                <span className="sp-thumb" style={{ background: p.photo ? `center/cover url(${p.photo})` : p.colour || 'var(--gray-soft)' }} />
                <span className="grow"><strong className="bn-ok">{p.name}</strong><small className="muted">{p.code} · {t.money(p.price)} · {t(`cat.state.${p.state}`)}</small></span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="small faint" style={{ marginTop: 10 }}>{t('sp.hint')}</p>
    </Drawer>
  );
}
