// Builds the widget with esbuild and checks its size budget (docs/DESIGN.md sections 2.4, 6.2):
//
//   dist/widget.js         classic script (IIFE), auto-renders data-sitekey elements
//   dist/widget.mjs        ES module for bundlers
//   dist/widget.worker.js  the PoW Web Worker
//   dist/sri.json          sha384 SRI hashes and raw and gzipped sizes of the three files
//
// Fails when widget.js or widget.mjs is over BUDGET_GZIP bytes gzipped, or the worker over
// WORKER_BUDGET_GZIP. `node build.mjs` from widget/, or `npm run build -w widget` from the root.

import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const BUDGET_GZIP = 25_000;
const WORKER_BUDGET_GZIP = 5_000;

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here('./dist/');

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ['es2022', 'chrome100', 'firefox100', 'safari15.4'],
  legalComments: 'none',
  logLevel: 'warning',
  // The widget bundles the shared sources directly, so no build of shared/ is needed first.
  alias: { '@belarusian-captcha/shared': here('../shared/src/index.ts') },
  banner: { js: '/*! belarusian-captcha widget | Apache-2.0 */' },
};

for (const f of ['widget.js', 'widget.mjs', 'widget.worker.js', 'sri.json']) {
  rmSync(`${dist}${f}`, { force: true });
}
await Promise.all([
  build({
    ...common,
    entryPoints: [here('./src/auto.ts')],
    outfile: `${dist}widget.js`,
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: [here('./src/index.ts')],
    outfile: `${dist}widget.mjs`,
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: [here('./src/worker.ts')],
    outfile: `${dist}widget.worker.js`,
    format: 'iife',
  }),
]);

const report = {};
let over = false;
for (const [file, budget] of [
  ['widget.js', BUDGET_GZIP],
  ['widget.mjs', BUDGET_GZIP],
  ['widget.worker.js', WORKER_BUDGET_GZIP],
]) {
  const bytes = readFileSync(`${dist}${file}`);
  const gzip = gzipSync(bytes, { level: 9 }).length;
  const sri = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  report[file] = { bytes: bytes.length, gzip, budget, sri };
  const ok = gzip <= budget;
  if (!ok) over = true;
  console.log(
    `${ok ? 'ok  ' : 'OVER'} ${file.padEnd(17)} ${String(bytes.length).padStart(6)} B, ${String(gzip).padStart(5)} B gzipped (budget ${budget} B)`,
  );
}
writeFileSync(`${dist}sri.json`, `${JSON.stringify(report, null, 2)}\n`);
if (over) {
  console.error('::error::widget size budget exceeded (docs/DESIGN.md section 6.2)');
  process.exit(1);
}
