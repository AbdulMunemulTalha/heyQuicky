import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const pub = new URL('../client/public/', import.meta.url);
const pngSize = (file) => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('the dashboard installs as an app: manifest, icons and service worker are in place', () => {
  const m = JSON.parse(readFileSync(new URL('manifest.webmanifest', pub), 'utf8'));
  assert.equal(m.start_url, '/app/');
  assert.equal(m.scope, '/app/');
  assert.equal(m.display, 'standalone');
  for (const icon of m.icons) {
    const file = new URL(`.${icon.src.replace(/^\/app/, '')}`, pub);
    assert.ok(existsSync(file), `${icon.src} exists`);
    const [w, h] = pngSize(file);
    assert.equal(`${w}x${h}`, icon.sizes, `${icon.src} is really ${icon.sizes}`);
  }
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'), 'Chrome needs 192 and 512');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  const sw = readFileSync(new URL('sw.js', pub), 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /addEventListener\('fetch'/);
  assert.match(sw, /!url\.pathname\.startsWith\('\/app'\)\) return;/, 'only dashboard pages and assets are handled; the API (/api) is never cached');
});
