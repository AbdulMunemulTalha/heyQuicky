import { useT } from '../lib/i18n.js';
import './rich.css';

// Screen 24: rich messages drawn the way the customer sees them in Messenger
// (product cards, quick replies, the order summary, delivery updates, the review request).
// Used by the inbox thread and the test chat. Buttons are shown, not clickable — only the customer taps them.

const soft = (hex) => {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return '#e8ddd0';
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.55);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
};

export function isRich(kind) {
  return ['carousel', 'quick_replies', 'order_summary', 'delivery_card', 'review_request'].includes(kind);
}

export function RichMessage({ kind, payload, text }) {
  const t = useT();
  if (!payload) return <span className="bn-ok">{text}</span>;
  switch (kind) {
    case 'carousel': return <Carousel t={t} cards={payload.cards ?? []} />;
    case 'quick_replies': case 'review_request': return <Quick text={payload.text} options={payload.options ?? []} />;
    case 'order_summary': return <Summary t={t} o={payload} />;
    case 'delivery_card': return <Delivery d={payload} />;
    default: return <span className="bn-ok">{text}</span>;
  }
}

function Buttons({ list }) {
  if (!list?.length) return null;
  return <div className="rm-buttons">{list.map((b) => <span key={b.title} className="rm-btn" title={b.type === 'url' ? b.value : undefined}>{b.title}</span>)}</div>;
}

function Carousel({ t, cards }) {
  return (
    <div className="rm-carousel" role="list">
      {cards.map((c) => {
        const off = c.compareAt ? Math.round((1 - c.price / c.compareAt) * 100) : 0;
        return (
          <div key={c.productId} className="rm-card" role="listitem">
            <div className="rm-img" style={{ background: c.image ? `center/cover url(${c.image})` : soft(c.colour) }}>
              {off > 0 && <span className="rm-off">{t('rm.off', { p: t.num(off) })}</span>}
              {!c.inStock && <span className="rm-off gray">{t('cat.state.out')}</span>}
            </div>
            <div className="rm-body">
              <strong className="bn-ok">{c.title}</strong>
              <span>{t.money(c.price)} {c.compareAt && <s className="muted">{t.money(c.compareAt)}</s>}</span>
              {(c.code || c.sizes?.length > 0) && <small className="muted">{[c.code, c.sizes?.join(', ')].filter(Boolean).join(' · ')}</small>}
            </div>
            <Buttons list={c.buttons} />
          </div>
        );
      })}
    </div>
  );
}

function Quick({ text, options }) {
  return (
    <div className="rm-quick">
      <span className="bn-ok rm-text">{text}</span>
      <div className="rm-chips">{options.map((o) => <span key={o.value} className="rm-chip bn-ok">{o.title}</span>)}</div>
    </div>
  );
}

function Summary({ t, o }) {
  return (
    <div className="rm-summary">
      <div className="rm-sum-head bn-ok">{t('rm.yourOrder')} <span className="muted">#{t.digits(o.number)}</span></div>
      <div className="rm-sum-body">
        {o.items.map((i, n) => <div key={n} className="rm-line bn-ok"><span>{i.name}{i.variant ? ` (${i.variant})` : ''} × {t.num(i.qty)}</span><span>{t.money(i.price * i.qty)}</span></div>)}
        <div className="rm-line muted"><span>{t('rm.delivery')}</span><span>{t.money(o.delivery)}</span></div>
        {o.discount > 0 && <div className="rm-line muted"><span>{t('rm.discount')}</span><span>−{t.money(o.discount)}</span></div>}
        <div className="rm-line rm-total"><span>{o.cod ? t('rm.totalCod') : t('rm.total')}</span><span>{t.money(o.cod || o.total)}</span></div>
        <small className="muted bn-ok">{[o.name, o.phone].filter(Boolean).join(' · ')}<br />{o.address}</small>
      </div>
      <Buttons list={o.buttons} />
    </div>
  );
}

function Delivery({ d }) {
  return (
    <div className="rm-summary">
      <div className="rm-sum-body">
        <strong className="bn-ok">{d.title}</strong>
        {d.subtitle && <small className="muted bn-ok">{d.subtitle}</small>}
      </div>
      <Buttons list={d.buttons} />
    </div>
  );
}
