import { Router } from 'express';

// CAT-05: a size chart as a public page (/size/:token), linked from the chart message in chat.
// Bangla first, readable on any phone without JavaScript.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Noto Sans Bengali","Hind Siliguri",sans-serif;background:#f6f5f1;color:#15171c}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
.card{background:#fff;border:1px solid #e6e3dc;border-radius:16px;padding:18px;margin-top:14px}
h1{font-size:20px;margin:0 0 4px}.muted{color:#6b6f78;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px;margin-top:6px}
th,td{border:1px solid #e6e3dc;padding:8px 6px;text-align:center}thead th{background:#f3f1ec}tbody th{background:#fafaf7}
img{max-width:100%;border-radius:12px;border:1px solid #e6e3dc}
.how{white-space:pre-wrap}footer{text-align:center;margin-top:24px}
</style></head><body><main>${body}<footer class="muted">Powered by HeyQuicky</footer></main></body></html>`;
}

export function sizePageRoutes(db) {
  const router = Router();
  router.get('/size/:token', async (req, res) => {
    const chart = /^[\w-]{8,40}$/.test(req.params.token) ? await db.sizeCharts.findOne({ token: req.params.token }).lean() : null;
    res.set('Cache-Control', 'no-store');
    if (!chart) return res.status(404).type('html').send(page('সাইজ চার্ট পাওয়া যায়নি', '<div class="card"><h1>সাইজ চার্ট পাওয়া যায়নি</h1><p class="muted">লিংকটি ভুল হতে পারে। শপকে মেসেজ করে আবার চান।</p></div>'));
    const ws = await db.workspaces.findById(chart.workspace_id, { name: 1 }).lean();
    const unit = chart.unit === 'cm' ? 'সেমি' : 'ইঞ্চি';
    const table = `<table><thead><tr>${chart.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${chart.rows.map((r) => `<tr>${r.map((v, i) => (i === 0 ? `<th scope="row">${esc(v)}</th>` : `<td>${esc(v)}</td>`)).join('')}</tr>`).join('')}</tbody></table>`;
    res.type('html').send(page(`${chart.name} — সাইজ চার্ট`, `
<p class="muted">${esc(ws?.name ?? '')}</p>
<h1>${esc(chart.name)}</h1><p class="muted">সাইজ চার্ট · মাপ ${unit}-তে</p>
${chart.image ? `<div class="card"><img src="${esc(chart.image)}" alt="${esc(chart.name)}"></div>` : ''}
<div class="card">${table}</div>
${chart.how_to ? `<div class="card"><strong>মাপ নেওয়ার নিয়ম</strong><p class="how">${esc(chart.how_to)}</p></div>` : ''}
<p class="muted" style="margin-top:14px">মাপ নিয়ে চ্যাটে আপনার সাইজ জানান — আমরা মিলিয়ে দেব।</p>`));
  });
  return router;
}
