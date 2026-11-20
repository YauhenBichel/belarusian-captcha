// ES module entry (dist/widget.mjs), for bundlers and <script type="module">. Nothing renders by
// itself: call render() or renderAll(). The worker is looked up next to this module; when a
// bundler moves the module, pass `workerUrl` (or the PoW runs on the main thread).

import * as registry from './registry.js';
import type { RenderOptions } from './widget.js';

export type { WidgetErrorCode } from './api.js';
export type { Lang } from './i18n.js';
export type { PowFound, PowJob, PowSolver, PowTask } from './pow.js';
export { getResponse, optionsFromElement, remove, reset, SELECTOR } from './registry.js';
export {
  CaptchaWidget,
  RESPONSE_FIELD,
  type RenderOptions,
  type Theme,
  type WidgetEvents,
} from './widget.js';

function moduleDefaults(): registry.Defaults {
  try {
    return { workerUrl: new URL('./widget.worker.js', import.meta.url).href };
  } catch {
    return {};
  }
}

export function render(el: HTMLElement | string, opts: RenderOptions) {
  return registry.render(el, opts, moduleDefaults());
}

export function renderAll(root: ParentNode = document) {
  return registry.renderAll(root, moduleDefaults());
}
