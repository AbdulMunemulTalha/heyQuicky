import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// UX-02 · Dark theme: screens follow the theme through the shared colour variables in dashboard.css.
// This guards against light-only colours coming back in screen stylesheets (they look broken in dark).
const DIR = new URL('../client/src/dashboard/screens/', import.meta.url);
// Relative luminance of a #rgb / #rrggbb colour (0 = black, 1 = white).
function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const LIGHT_BG = { test: (hex) => luminance(hex) > 0.7 }; // pale backgrounds (white, tints)
const DARK_TEXT = { test: (hex) => luminance(hex) < 0.12 }; // dark text that disappears on dark

// Colours that are meant to be the same in both themes: brand chips and always-dark cards.
const ALLOWED = [/\.set-balance/, /\.pm-method\./, /\.pg-logo/, /\.wn-video/, /\.cs-legend i/, /bkash|nagad|messenger|instagram|whatsapp|sslcommerz/i, /\.set-bkash|\.sel-yellow|\.pl-pct|\.pl-tag/, /\.toggle|\.knob/, /\.avatar/, /\.login|\.lg-/, /\.th-(light|dark|system)/, /\.sc-img/, /\.wt-phone|\.wt-bubble/];

function* declarations(css) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    for (const d of m[2].matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) yield { selector, prop: d[1], value: d[2] };
  }
}
const outsideVar = (value) => value.replace(/var\([^()]*(\([^()]*\)[^()]*)*\)/g, '');

test('screen stylesheets use theme colours, not light-only ones', () => {
  const problems = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.css'))) {
    const css = readFileSync(join(DIR.pathname.replace(/^\/([A-Z]:)/, '$1'), f), 'utf8');
    for (const { selector, prop, value } of declarations(css)) {
      if (ALLOWED.some((rx) => rx.test(selector))) continue;
      const hexes = outsideVar(value).match(/#[0-9a-f]{3,6}\b/gi) ?? [];
      for (const hex of hexes) {
        if (/^background(-color)?$/.test(prop) && LIGHT_BG.test(hex)) problems.push(`${f}: ${selector} { ${prop}: ${hex} } — use var(--panel) / var(--*-soft)`);
        if (prop === 'color' && DARK_TEXT.test(hex)) problems.push(`${f}: ${selector} { color: ${hex} } — use var(--text) / var(--*-text)`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the dark theme defines every colour variable the light theme has', () => {
  const css = readFileSync(new URL('../client/src/dashboard/dashboard.css', import.meta.url), 'utf8');
  const block = (rx) => new Set([...(css.match(rx)?.[1] ?? '').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const light = block(/#dash\s*\{([^}]*)\}/);
  const dark = block(/#dash\[data-theme="dark"\]\s*\{([^}]*)\}/);
  // Colours only (fonts, radius and brand colours stay the same).
  const colours = [...light].filter((v) => !/display|bangla|radius|messenger|instagram|whatsapp|^--yellow$|^--green$|^--orange$|^--red$|^--purple$|^--shadow$/.test(v));
  assert.deepEqual(colours.filter((v) => !dark.has(v)), []);
});
