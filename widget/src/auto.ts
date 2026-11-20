// Classic-script entry (dist/widget.js, an IIFE): <script src=".../widget.js" async defer>.
// It exposes window.belarusianCaptcha and renders every `.belarusian-captcha[data-sitekey]` once
// the document is parsed. The API origin and the worker default to where this script came from
// (data-api and data-worker override them per element).

import * as registry from './registry.js';
import type { RenderOptions } from './widget.js';

const script = document.currentScript as HTMLScriptElement | null;
const src = script?.src ? new URL(script.src, document.baseURI) : undefined;
const defaults: registry.Defaults = src
  ? { api: src.origin, workerUrl: new URL('widget.worker.js', src).href }
  : {};

const api = {
  render: (el: HTMLElement | string, opts: RenderOptions) => registry.render(el, opts, defaults),
  renderAll: (root: ParentNode = document) => registry.renderAll(root, defaults),
  reset: registry.reset,
  getResponse: registry.getResponse,
  remove: registry.remove,
};

(globalThis as unknown as { belarusianCaptcha: typeof api }).belarusianCaptcha = api;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => api.renderAll(), { once: true });
} else {
  api.renderAll();
}
