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
  return ['carousel', 'quick_replies', 'order_summary', 'delivery_card', 'review_request', 'size_chart', 'quote'].includes(kind);
}

export function RichMessage({ kind, payload, text }) {
  const t = useT();
  if (!payload) return <span className="bn-ok">{text}</span>;
  switch (kind) {
    case 'carousel': return <Carousel t={t} cards={payload.cards ?? []} />;
    case 'quick_replies': case 'review_request': return <Quick text={payload.text} options={payload.options ?? []} />;
    case 'order_summary': return <Summary t={t} o={payload} />;
    case 'delivery_card': return <Delivery d={payload} />;
    case 'quote': return (
      <div className="rm-card rm-quote">
        <strong>🧾 Q-{payload.number} · {payload.title}</strong>
        <span>৳{Number(payload.price).toLocaleString('en-IN')}{payload.advance ? ` · অগ্রিম ৳${Number(payload.advance).toLocaleString('en-IN')}` : ''}</span>
        <div className="rm-buttons">{payload.buttons.map((b) => <span key={b.value} className="rm-btn">{b.title}</span>)}</div>
      </div>
    );
    case 'size_chart': return <SizeChart t={t} c={payload} />;
    default: return <span className="bn-ok">{text}</span>;
  }
}

// CAT-05: the chart the customer gets — the shop's picture, or the table — with the sizes to tap.
export function SizeChart({ t, c }) {
  return (
    <div className="rm-chart">
      <strong className="bn-ok">{c.productName || c.name} · {t(c.unit === 'cm' ? 'sc.cm' : 'sc.inch')}</strong>
      {c.image ? <img src={c.image} alt={c.name} className="rm-chart-img" /> : (
        <table className="rm-chart-table">
          <thead><tr>{c.columns.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
          <tbody>{c.rows.map((r, i) => <tr key={i}>{r.map((v, j) => (j === 0 ? <th key={j} scope="row">{v}</th> : <td key={j}>{v}</td>))}</tr>)}</tbody>
        </table>
      )}
      {c.howTo && <small className="muted bn-ok">{c.howTo}</small>}
      {c.options?.length > 0 && <div className="rm-chips">{c.options.map((o) => <span key={o.title} className="rm-chip">{o.title}</span>)}</div>}
    </div>
  );
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
