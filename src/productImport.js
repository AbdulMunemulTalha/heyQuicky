// Product lists from a CSV file or a shared Google Sheet.

// RFC 4180-style CSV: quoted fields may hold commas, quotes ("") and new lines.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Header names people actually use, in English and Bangla.
const COLUMNS = {
  name: ['name', 'product', 'product name', 'title', 'item', 'নাম', 'প্রোডাক্ট'],
  price: ['price', 'price (bdt)', 'price (tk)', 'price (taka)', 'dam', 'rate', 'sale price', 'দাম', 'মূল্য'],
  variants: ['variants', 'options', 'size', 'sizes', 'colour', 'color', 'variant', 'সাইজ'],
  description: ['description', 'details', 'desc', 'বিবরণ'],
  stock: ['stock', 'in stock', 'in_stock', 'available', 'quantity', 'qty', 'স্টক'],
};

const OUT_OF_STOCK = new Set(['0', 'no', 'false', 'n', 'out', 'out of stock', 'sold out', 'না', 'নেই']);

// Bangla digits and "৳1,200" / "1200 tk" style prices to a whole number of taka.
function toTaka(value) {
  const ascii = String(value).replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const match = ascii.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return match ? Math.round(Number(match[0])) : NaN;
}

// Rows (first row = headers) to product fields. Returns what to add and what was skipped, with reasons.
export function productsFromRows(rows, { max = 500 } = {}) {
  if (!rows.length) return { products: [], skipped: [], error: 'The file is empty.' };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [key, headers.findIndex((h) => names.includes(h))]));
  if (col.name < 0 || col.price < 0) {
    return { products: [], skipped: [], error: 'Add a header row with at least "Name" and "Price" columns.' };
  }
  const products = [];
  const skipped = [];
  for (const [i, cells] of rows.slice(1).entries()) {
    const line = i + 2;
    const get = (key) => (col[key] >= 0 ? String(cells[col[key]] ?? '').trim() : '');
    const name = get('name');
    const price = toTaka(get('price'));
    if (!name) { skipped.push({ line, reason: 'no product name' }); continue; }
    if (name.length > 120) { skipped.push({ line, reason: 'name is longer than 120 characters' }); continue; }
    if (!Number.isInteger(price) || price < 0) { skipped.push({ line, reason: `"${get('price') || 'blank'}" is not a price` }); continue; }
    if (products.length >= max) { skipped.push({ line, reason: `only the first ${max} products are imported at once` }); continue; }
    const stock = get('stock').toLowerCase();
    products.push({
      name,
      price,
      variants: get('variants').slice(0, 300),
      description: get('description').slice(0, 1000),
      in_stock: !OUT_OF_STOCK.has(stock),
    });
  }
  return { products, skipped, error: null };
}

// A Google Sheets link ("Anyone with the link can view") to its CSV export URL.
// Only docs.google.com is ever fetched, so a pasted link can't make the server call anywhere else.
export function googleSheetCsvUrl(link) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
  const id = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/)?.[1];
  if (!id) return null;
  const gid = (url.hash.match(/gid=(\d+)/) ?? url.search.match(/gid=(\d+)/))?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}
