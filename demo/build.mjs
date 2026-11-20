// Builds the static demo site into demo/dist (what GitHub Pages serves):
//
//   BC_DEMO_SITE_URL  the public URL of the page, with a trailing slash (canonical, sitemap)
//                     default https://yauhenbichel.github.io/belarusian-captcha/
//   BC_DEMO_API       the default API base URL (the page's ?api= overrides it)
//                     default https://captcha.yserver.invalid: a placeholder until the API is
//                     deployed (.invalid never resolves, so the page says it cannot be reached)
//   BC_DEMO_SITEKEY   the default site key (?sitekey= overrides it); default demo-sitekey-0001
//
// Needs the widget built first (npm run build:widget); `npm run build:demo` does both.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = here('./src/');
const dist = here('./dist/');
const widget = here('../widget/dist/');

export const DEFAULTS = {
  siteUrl: 'https://yauhenbichel.github.io/belarusian-captcha/',
  api: 'https://captcha.yserver.invalid',
  sitekey: 'demo-sitekey-0001',
};

function httpUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${name} must be http(s)`);
  return u.href;
}

const siteUrl = httpUrl('BC_DEMO_SITE_URL', process.env.BC_DEMO_SITE_URL || DEFAULTS.siteUrl);
if (!siteUrl.endsWith('/')) throw new Error('BC_DEMO_SITE_URL must end with "/"');
const api = httpUrl('BC_DEMO_API', process.env.BC_DEMO_API || DEFAULTS.api).replace(/\/+$/, '');
const sitekey = process.env.BC_DEMO_SITEKEY || DEFAULTS.sitekey;
if (!/^[A-Za-z0-9_-]{8,64}$/.test(sitekey)) throw new Error('BC_DEMO_SITEKEY is not a site key');

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fill = (text, esc) =>
  text
    .replaceAll('__SITE_URL__', esc(siteUrl))
    .replaceAll('__API__', esc(api))
    .replaceAll('__SITEKEY__', esc(sitekey))
    .replaceAll('__LASTMOD__', new Date().toISOString().slice(0, 10));

for (const f of ['widget.js', 'widget.worker.js']) {
  if (!existsSync(`${widget}${f}`))
    throw new Error(`widget/dist/${f} missing: run npm run build:widget`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(`${dist}index.html`, fill(readFileSync(`${src}index.html`, 'utf8'), escapeHtml));
writeFileSync(`${dist}sitemap.xml`, fill(readFileSync(`${src}sitemap.xml`, 'utf8'), escapeHtml));
writeFileSync(
  `${dist}robots.txt`,
  fill(readFileSync(`${src}robots.txt`, 'utf8'), (s) => s),
);
for (const f of ['demo.js', 'demo.css']) copyFileSync(`${src}${f}`, `${dist}${f}`);
for (const f of ['widget.js', 'widget.worker.js']) copyFileSync(`${widget}${f}`, `${dist}${f}`);
// GitHub Pages: serve files as they are (no Jekyll processing).
writeFileSync(`${dist}.nojekyll`, '');
console.log(`demo built in demo/dist: site ${siteUrl}, API ${api}, site key ${sitekey}`);
