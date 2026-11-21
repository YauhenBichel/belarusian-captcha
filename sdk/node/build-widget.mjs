// Copies the widget build into this package (docs/DESIGN.md section 6.4), so `import { render }
// from 'belarusian-captcha'` works in a bundler:
//
//   dist/widget/widget.mjs         the ES module (widget/dist/widget.mjs)
//   dist/widget/widget.worker.js   the PoW worker, next to the module: widget.mjs looks it up with
//                                  new URL('./widget.worker.js', import.meta.url), which bundlers
//                                  follow and emit as an asset
//   dist/widget/*.d.ts             the declarations index.d.ts reaches, without source maps
//
// The declarations must stand alone: each import has to be a relative './x.js' that resolves to
// another declaration in the set. Anything else (the private shared package, a JSON module) fails
// the build, because a site's type-check would fail on it. Needs the widget built first
// (`npm run build:widget`); `npm run build` at the root does both.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = here('../../widget/dist/');
const out = here('./dist/widget/');

for (const f of ['widget.mjs', 'widget.worker.js', 'types/index.d.ts']) {
  if (!existsSync(`${src}${f}`)) {
    throw new Error(`widget/dist/${f} missing: run npm run build:widget first`);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(`${src}widget.mjs`, `${out}widget.mjs`);
copyFileSync(`${src}widget.worker.js`, `${out}widget.worker.js`);

const IMPORT =
  /(?:^|\s)(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const seen = new Set();
const queue = ['index'];
while (queue.length > 0) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const text = readFileSync(`${src}types/${name}.d.ts`, 'utf8');
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2];
    const local = /^\.\/([A-Za-z0-9_-]+)\.js$/.exec(spec)?.[1];
    if (!local || !existsSync(`${src}types/${local}.d.ts`)) {
      throw new Error(
        `widget/dist/types/${name}.d.ts imports '${spec}': the published types must import only` +
          ' their own files (move the type into widget/src/types.ts)',
      );
    }
    queue.push(local);
  }
  writeFileSync(`${out}${name}.d.ts`, text.replace(/\n?\/\/# sourceMappingURL=.*\n?$/, '\n'));
}
console.log(`sdk/node: widget copied (widget.mjs, widget.worker.js, ${seen.size} declarations)`);
