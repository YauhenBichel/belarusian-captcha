// The JS API (docs/DESIGN.md section 6.1): render(el, opts), reset(), getResponse(), and the
// `data-*` embed: <div class="belarusian-captcha" data-sitekey="..."> rendered by renderAll().

import type { WidgetErrorCode } from './api.js';
import { CaptchaWidget, type RenderOptions, type Theme } from './widget.js';

export const SELECTOR = '.belarusian-captcha[data-sitekey]';

const widgets: CaptchaWidget[] = [];

/** Defaults the entry point knows (the API origin and worker URL of the script itself). */
export type Defaults = Pick<RenderOptions, 'api' | 'workerUrl'>;

export function render(
  el: HTMLElement | string,
  opts: RenderOptions,
  defaults: Defaults = {},
): CaptchaWidget {
  const host = typeof el === 'string' ? document.querySelector<HTMLElement>(el) : el;
  if (!host) throw new Error(`belarusian-captcha: no element ${String(el)}`);
  const w = new CaptchaWidget(host, { ...defaults, ...stripUndefined(opts) });
  widgets.push(w);
  return w;
}

/** Resets one widget, or the first one rendered. */
export function reset(w: CaptchaWidget | undefined = widgets[0]): void {
  w?.reset();
}

/** The pass token of one widget, or of the first one rendered. */
export function getResponse(w: CaptchaWidget | undefined = widgets[0]): string {
  return w?.getResponse() ?? '';
}

/** Removes a widget and forgets it. */
export function remove(w: CaptchaWidget): void {
  w.destroy();
  const i = widgets.indexOf(w);
  if (i >= 0) widgets.splice(i, 1);
}

/** A global function named by a data-*-callback attribute, looked up when it is called. */
function named<A extends unknown[]>(name: string | undefined): ((...args: A) => void) | undefined {
  if (!name) return undefined;
  return (...args: A) => {
    const fn = (globalThis as unknown as Record<string, unknown>)[name];
    if (typeof fn === 'function') fn(...args);
  };
}

/** Options from an element's data-* attributes. */
export function optionsFromElement(el: HTMLElement): RenderOptions {
  const d = el.dataset;
  return stripUndefined({
    sitekey: d.sitekey ?? '',
    api: d.api,
    lang: d.lang,
    script: d.script,
    theme: d.theme as Theme | undefined,
    action: d.action,
    types: d.types,
    workerUrl: d.worker,
    callback: named<[string]>(d.callback),
    expiredCallback: named<[]>(d.expiredCallback),
    errorCallback: named<[WidgetErrorCode]>(d.errorCallback),
  });
}

/** Renders every `.belarusian-captcha[data-sitekey]` element under `root` not rendered yet. */
export function renderAll(root: ParentNode = document, defaults: Defaults = {}): CaptchaWidget[] {
  const out: CaptchaWidget[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    if (el.dataset.bcRendered !== undefined || el.shadowRoot) continue;
    out.push(render(el, optionsFromElement(el), defaults));
  }
  return out;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
