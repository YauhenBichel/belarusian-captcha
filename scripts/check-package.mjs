// Checks the npm package `belarusian-captcha` the way a site gets it: `npm pack`, unpack into a
// throwaway consumer project, then
//
//   1. the tarball holds the server SDK and the widget (module, worker, declarations) and no tests;
//   2. a consumer file importing both entry points type-checks with strict settings and no
//      skipLibCheck, under `moduleResolution: bundler` (DOM, as a site's bundle) and `nodenext`
//      (as a backend), so the published declarations stand alone;
//   3. Node resolves the entry points: `belarusian-captcha/server` imports and exports verify, and
//      the widget module and its worker resolve to the shipped files.
//
// `npm run check:package` builds the package first. Nothing is installed from the network.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const work = mkdtempSync(join(tmpdir(), 'bc-package-'));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fail(msg) {
  console.error(`::error::check-package: ${msg}`);
  process.exitCode = 1;
}

try {
  // 1. The tarball.
  const packed = JSON.parse(
    run('npm', ['pack', '-w', 'sdk/node', '--json', '--pack-destination', work], root),
  );
  const files = packed[0].files.map((f) => f.path).sort();
  for (const want of [
    'dist/server.js',
    'dist/server.d.ts',
    'dist/widget/widget.mjs',
    'dist/widget/widget.worker.js',
    'dist/widget/index.d.ts',
    'dist/widget/types.d.ts',
    'package.json',
  ]) {
    if (!files.includes(want)) fail(`the package has no ${want}`);
  }
  for (const f of files) {
    if (/\.test\.|test-helpers|\.tsbuildinfo|build-widget\.mjs/.test(f))
      fail(`the package ships ${f}`);
  }

  const consumer = join(work, 'site');
  const pkgDir = join(consumer, 'node_modules', 'belarusian-captcha');
  mkdirSync(pkgDir, { recursive: true });
  run(
    'tar',
    ['-xzf', join(work, packed[0].filename), '-C', pkgDir, '--strip-components', '1'],
    root,
  );
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'site', private: true, type: 'module' }),
  );

  // 2. Type-check a consumer.
  writeFileSync(
    join(consumer, 'widget.ts'),
    `import {
  type CaptchaWidget, getResponse, type Lang, type RenderOptions, render, renderAll, reset,
  RESPONSE_FIELD, type WidgetErrorCode, type WidgetEvents,
} from 'belarusian-captcha';

const lang: Lang = 'be-Latn';
const opts: RenderOptions = {
  sitekey: 'bc_pk_example',
  lang,
  theme: 'auto',
  errorCallback: (code: WidgetErrorCode) => console.warn(code === 'rate-limited', code),
  callback: (token: string) => console.log(token.length),
};
const w: CaptchaWidget = render('#captcha', opts);
const all: CaptchaWidget[] = renderAll(document);
reset(w);
const field: 'bc-response' = RESPONSE_FIELD;
const solved: WidgetEvents['bc-solved'] = { token: getResponse(w), expires: 0, powMs: 0 };
console.log(all.length, field, solved, w.lang);
// @ts-expect-error: not a widget error code
const bad: WidgetErrorCode = 'no-such-code';
console.log(bad);
`,
  );
  writeFileSync(
    join(consumer, 'server.ts'),
    `import { verify, type VerifyResult } from 'belarusian-captcha/server';

const r: VerifyResult = await verify('token', { secret: 's', url: 'https://captcha.example.by' });
console.log(r.success, r.error_codes);
`,
  );
  const strict = {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    target: 'es2022',
    types: [],
  };
  const configs = {
    'tsconfig.bundler.json': {
      compilerOptions: {
        ...strict,
        module: 'esnext',
        moduleResolution: 'bundler',
        lib: ['es2022', 'dom', 'dom.iterable'],
      },
      files: ['widget.ts', 'server.ts'],
    },
    'tsconfig.node.json': {
      compilerOptions: {
        ...strict,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        lib: ['es2022', 'dom'],
      },
      files: ['widget.ts', 'server.ts'],
    },
  };
  for (const [name, config] of Object.entries(configs)) {
    writeFileSync(join(consumer, name), JSON.stringify(config));
    try {
      run(process.execPath, [tsc, '-p', name], consumer);
    } catch (err) {
      fail(`a consumer does not type-check with ${name}:\n${err.stdout}${err.stderr}`);
    }
  }

  // 3. Node resolves the entry points.
  const probe = `
const server = await import('belarusian-captcha/server');
if (typeof server.verify !== 'function') throw new Error('belarusian-captcha/server has no verify');
const { existsSync } = await import('node:fs');
for (const spec of ['belarusian-captcha', 'belarusian-captcha/widget.worker.js']) {
  const path = new URL(import.meta.resolve(spec)).pathname;
  if (!existsSync(path)) throw new Error(spec + ' resolves to a missing file: ' + path);
}
`;
  writeFileSync(join(consumer, 'probe.mjs'), probe);
  try {
    run(process.execPath, ['probe.mjs'], consumer);
  } catch (err) {
    fail(`Node cannot use the package:\n${err.stderr}`);
  }

  if (!process.exitCode) {
    const widgetFiles = readdirSync(join(pkgDir, 'dist', 'widget')).length;
    console.log(
      `package ok: ${files.length} files (${widgetFiles} in dist/widget), consumer type-checks` +
        ' under bundler and nodenext resolution, Node resolves ./server, . and ./widget.worker.js',
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
