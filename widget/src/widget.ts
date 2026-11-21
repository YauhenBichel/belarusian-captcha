// One widget instance (docs/DESIGN.md sections 2.2 and 6): fetch a challenge, start the
// proof-of-work at once, show the proverb with its endings as a radio group, and when every
// question has an answer and the PoW is found, POST /solve. A pass token goes into the hidden
// input `bc-response` of the enclosing form; a wrong answer brings the next challenge.
//
// Accessibility (section 6.2): a labelled group; each question is a `radiogroup` named by its
// prompt (arrow keys, Home and End move, Space or Enter picks); status changes go to one
// aria-live="polite" region; focus never moves on load, only to keep it inside the widget when
// the element that had it is replaced. The non-visual alternative (section 6.3, D3): the proverb
// is plain text, so a screen reader reads it as is (option C), and the "I cannot do this
// challenge" button under it (option B) is the way through for anyone the language or the task
// excludes: GET /api/v1/fallback brings a challenge with no question and a harder proof-of-work,
// which the widget solves and sends with an empty answer. The site's backend sees the pass as
// `fallback: true` with a low score, and decides what it may do.

import {
  type ChallengeResponse,
  encodePowSolution,
  POW_ALGORITHM,
} from '@belarusian-captcha/shared';
import { ApiClient, ApiError } from './api.js';
import { parseLang, type StringKey, t } from './i18n.js';
import { workerSolver } from './pow.js';
import { applyStyles } from './styles.js';
import type { Lang, PowJob, PowSolver, WidgetErrorCode } from './types.js';

export type Theme = 'light' | 'dark' | 'auto';

/** The name of the hidden form field that carries the pass token. */
export const RESPONSE_FIELD = 'bc-response';

export interface RenderOptions {
  sitekey: string;
  /** The API origin (and optional path prefix). Default: the origin the script came from. */
  api?: string | undefined;
  lang?: Lang | string | undefined;
  /** Content script: `cyrl` (default on the server). */
  script?: string | undefined;
  theme?: Theme | undefined;
  /** Bound into the pass token; siteverify can require it. */
  action?: string | undefined;
  /** A subset of challenge types, comma-separated. */
  types?: string | undefined;
  /** Called with the pass token. */
  callback?: ((token: string) => void) | undefined;
  /** Called when the pass token expires unused (the widget then loads a new challenge). */
  expiredCallback?: (() => void) | undefined;
  /** Called with an error code when the check cannot be completed. */
  errorCallback?: ((code: WidgetErrorCode) => void) | undefined;
  /** URL of widget.worker.js. Without it, or if it cannot start, the PoW runs on the main thread. */
  workerUrl?: string | undefined;
  /** Replaces the PoW solver (tests). */
  solver?: PowSolver | undefined;
  /** Replaces fetch (tests). */
  fetch?: typeof fetch | undefined;
}

/** Events dispatched on the host element (they do not cross into the page as bubbling events). */
export interface WidgetEvents {
  'bc-challenge': {
    type: string;
    questions: number;
    maxnumber: number;
    expires: number;
    sealed: string;
  };
  'bc-solved': { token: string; expires: number; powMs: number };
  'bc-rejected': { error: WidgetErrorCode };
  'bc-error': { error: WidgetErrorCode };
  'bc-expired': Record<string, never>;
}

type StatusKind = 'busy' | 'ok' | 'error' | 'info';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

export class CaptchaWidget {
  readonly host: HTMLElement;
  readonly lang: Lang;
  readonly #opts: RenderOptions;
  readonly #api: ApiClient;
  readonly #solver: PowSolver;
  readonly #root: ShadowRoot;
  readonly #box: HTMLDivElement;
  readonly #questions: HTMLDivElement;
  readonly #status: HTMLParagraphElement;
  readonly #statusText: HTMLSpanElement;
  readonly #spinner: HTMLSpanElement;
  readonly #retry: HTMLButtonElement;
  readonly #cannot: HTMLButtonElement;
  readonly #input: HTMLInputElement;
  #gen = 0;
  #challenge: ChallengeResponse | undefined;
  #picks: (string | undefined)[] = [];
  #job: PowJob | undefined;
  #busy = false;
  #token = '';
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(host: HTMLElement, opts: RenderOptions) {
    if (!opts.sitekey) throw new Error('belarusian-captcha: sitekey is required');
    if (host.shadowRoot) throw new Error('belarusian-captcha: element already has a widget');
    this.host = host;
    this.#opts = opts;
    this.lang = parseLang(opts.lang);
    this.#api = new ApiClient(opts.api ?? globalThis.location.origin, opts.fetch);
    this.#solver = opts.solver ?? workerSolver(opts.workerUrl);
    if (opts.theme) host.dataset.theme = opts.theme;

    this.#root = host.attachShadow({ mode: 'open' });
    applyStyles(this.#root);
    const label = t(this.lang, 'label');
    const instr = t(this.lang, 'instruction');
    this.#box = el('div', {
      class: 'bc',
      role: 'group',
      'aria-labelledby': 'bc-title',
      'aria-describedby': 'bc-instr',
      lang: this.lang,
      tabindex: '-1',
    });
    this.#questions = el('div', { class: 'qs' });
    this.#status = el('p', {
      class: 'status',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    this.#spinner = el('span', { class: 'spin', 'aria-hidden': 'true' });
    this.#statusText = el('span');
    this.#status.append(this.#spinner, this.#statusText);
    const retry = t(this.lang, 'retry');
    this.#retry = el('button', { type: 'button', lang: retry.lang, hidden: '' }, retry.text);
    this.#retry.addEventListener('click', () => this.reset());
    const cannot = t(this.lang, 'cannot');
    this.#cannot = el(
      'button',
      { type: 'button', class: 'alt', lang: cannot.lang, hidden: '' },
      cannot.text,
    );
    this.#cannot.addEventListener('click', () => void this.#fallback());
    this.#box.append(
      el('p', { class: 'title', id: 'bc-title', lang: label.lang }, label.text),
      el('p', { class: 'instr', id: 'bc-instr', lang: instr.lang }, instr.text),
      this.#questions,
      this.#status,
      this.#retry,
      this.#cannot,
    );
    this.#root.append(this.#box);
    // The status starts as "loading": text present when the live region is created is not
    // announced, so a screen reader hears nothing on page load.
    this.#say('loading', 'busy');

    this.#input = el('input', { type: 'hidden', name: RESPONSE_FIELD, value: '' });
    host.append(this.#input);
    host.dataset.bcRendered = '';
    void this.#load();
  }

  /** The current pass token, or "" before a solve and after it expires. */
  getResponse(): string {
    return this.#token;
  }

  /** Drops the current challenge or token and loads a new challenge. */
  reset(): void {
    void this.#load();
  }

  /** Stops all work and removes the widget from its element. */
  destroy(): void {
    this.#gen++;
    this.#stopWork();
    this.#input.remove();
    this.#root.replaceChildren();
    delete this.host.dataset.bcRendered;
  }

  async #load(announce?: StringKey): Promise<void> {
    const gen = ++this.#gen;
    this.#stopWork();
    this.#setToken('');
    this.#busy = false;
    const hadFocus = this.#hasFocus();
    this.#questions.replaceChildren();
    this.#retry.hidden = true;
    this.#cannot.hidden = true;
    if (hadFocus) this.#box.focus();
    this.#say('loading', 'busy');
    let ch: ChallengeResponse;
    try {
      ch = await this.#api.challenge({
        sitekey: this.#opts.sitekey,
        lang: this.lang,
        script: this.#opts.script,
        types: this.#opts.types,
        action: this.#opts.action,
      });
    } catch (e) {
      if (gen === this.#gen) this.#fail(e instanceof ApiError ? e.code : 'bad-response');
      return;
    }
    if (gen === this.#gen) this.#show(ch, announce, hadFocus);
  }

  #show(ch: ChallengeResponse, announce: StringKey | undefined, focus: boolean): void {
    this.#stopWork();
    this.#challenge = ch;
    this.#busy = false;
    this.#picks = ch.display.questions.map(() => undefined);
    const blocks = ch.display.questions.map((q, qi) => {
      const promptId = `bc-q${this.#gen}-${qi}`;
      const group = el('div', { role: 'radiogroup', 'aria-labelledby': promptId });
      q.options.forEach((o, oi) => {
        const opt = el(
          'div',
          {
            class: 'opt',
            role: 'radio',
            'aria-checked': 'false',
            tabindex: oi === 0 ? '0' : '-1',
            'data-id': o.id,
            lang: 'be',
          },
          o.text,
        );
        opt.addEventListener('click', () => this.#pick(qi, group, opt));
        group.append(opt);
      });
      group.addEventListener('keydown', (e) => this.#onKey(e, qi, group));
      const block = el('div', { class: 'q' });
      block.append(el('p', { class: 'prompt', id: promptId, lang: 'be' }, q.prompt), group);
      return block;
    });
    this.#questions.replaceChildren(...blocks);
    this.#cannot.hidden = ch.type !== 'proverb';
    if (announce) this.#say(announce, 'info');
    else this.#say();
    this.#job = this.#solver(ch.pow);
    this.#emit('bc-challenge', {
      type: ch.type,
      questions: ch.display.questions.length,
      maxnumber: ch.pow.maxnumber,
      expires: ch.expires,
      sealed: ch.sealed,
    });
    if (focus) this.#options(this.#questions)[0]?.focus();
  }

  #options(scope: ParentNode): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>('[role="radio"]')];
  }

  #onKey(e: KeyboardEvent, qi: number, group: HTMLElement): void {
    const opts = this.#options(group);
    const i = opts.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (i + 1) % opts.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (i - 1 + opts.length) % opts.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = opts.length - 1;
        break;
      case ' ':
      case 'Enter':
        e.preventDefault();
        this.#pick(qi, group, opts[i] as HTMLElement);
        return;
      default:
        return;
    }
    e.preventDefault();
    this.#rove(opts, opts[next] as HTMLElement);
    (opts[next] as HTMLElement).focus();
  }

  #rove(opts: HTMLElement[], current: HTMLElement): void {
    for (const o of opts) o.tabIndex = o === current ? 0 : -1;
  }

  #pick(qi: number, group: HTMLElement, opt: HTMLElement): void {
    if (this.#busy) return;
    const opts = this.#options(group);
    for (const o of opts) o.setAttribute('aria-checked', String(o === opt));
    this.#rove(opts, opt);
    this.#picks[qi] = opt.dataset.id;
    if (this.#picks.every((p) => p !== undefined)) void this.#submit();
  }

  /**
   * The accessible way through: drop the question, fetch a fallback challenge, solve its
   * proof-of-work and send it with an empty answer. Focus stays in the widget.
   */
  async #fallback(): Promise<void> {
    const gen = ++this.#gen;
    const hadFocus = this.#hasFocus();
    this.#stopWork();
    this.#busy = true;
    this.#questions.replaceChildren();
    this.#cannot.hidden = true;
    if (hadFocus) this.#box.focus();
    this.#say('checkingLonger', 'busy');
    let ch: ChallengeResponse;
    try {
      ch = await this.#api.fallback({
        sitekey: this.#opts.sitekey,
        lang: this.lang,
        action: this.#opts.action,
      });
    } catch (e) {
      if (gen === this.#gen) this.#fail(e instanceof ApiError ? e.code : 'bad-response');
      return;
    }
    if (gen !== this.#gen) return;
    this.#challenge = ch;
    this.#picks = [];
    this.#job = this.#solver(ch.pow);
    this.#emit('bc-challenge', {
      type: ch.type,
      questions: 0,
      maxnumber: ch.pow.maxnumber,
      expires: ch.expires,
      sealed: ch.sealed,
    });
    await this.#submit('checkingLonger');
  }

  async #submit(status: StringKey = 'checking'): Promise<void> {
    const gen = this.#gen;
    const ch = this.#challenge;
    const job = this.#job;
    if (!ch || !job) return;
    this.#busy = true;
    this.#cannot.hidden = true;
    for (const o of this.#options(this.#questions)) o.setAttribute('aria-disabled', 'true');
    this.#say(status, 'busy');
    const found = await job.result;
    if (gen !== this.#gen) return;
    if (!found) return this.#fail('pow-failed');
    const pow = encodePowSolution({
      algorithm: POW_ALGORITHM,
      challenge: ch.pow.challenge,
      number: found.number,
      salt: ch.pow.salt,
      signature: ch.pow.signature,
      took: found.took,
    });
    let r: Awaited<ReturnType<ApiClient['solve']>>;
    try {
      r = await this.#api.solve({ sealed: ch.sealed, answer: this.#picks as string[], pow });
    } catch (e) {
      if (gen === this.#gen) this.#fail(e instanceof ApiError ? e.code : 'bad-response');
      return;
    }
    if (gen !== this.#gen) return;
    if (r.ok) return this.#solved(r.token, r.expires, found.took);
    this.#emit('bc-rejected', { error: r.error });
    // A refused fallback (an expired challenge, a failed proof-of-work) ends in "Try again",
    // which starts over with a question and the button again.
    if (!r.next || ch.type === 'fallback') return this.#fail(r.error);
    const key: StringKey =
      r.error === 'wrong-answer'
        ? 'wrong'
        : r.error === 'timeout-or-duplicate'
          ? 'expired'
          : 'failed';
    this.#show(r.next, key, this.#hasFocus());
  }

  #solved(token: string, expires: number, powMs: number): void {
    const hadFocus = this.#hasFocus();
    this.#busy = false;
    this.#job = undefined;
    this.#questions.replaceChildren();
    this.#cannot.hidden = true;
    if (hadFocus) this.#box.focus();
    this.#setToken(token);
    this.#say('done', 'ok');
    this.#emit('bc-solved', { token, expires, powMs });
    this.#opts.callback?.(token);
    this.#expiry = setTimeout(() => this.#expire(), Math.max(0, expires - Date.now()));
  }

  #expire(): void {
    this.#setToken('');
    this.#emit('bc-expired', {});
    this.#opts.expiredCallback?.();
    void this.#load('expired');
  }

  #fail(code: WidgetErrorCode): void {
    const hadFocus = this.#hasFocus();
    this.#stopWork();
    this.#busy = false;
    this.#questions.replaceChildren();
    this.#cannot.hidden = true;
    const key: StringKey =
      code === 'network-error' ? 'unreachable' : code === 'rate-limited' ? 'rateLimited' : 'failed';
    this.#say(key, 'error');
    this.#retry.hidden = false;
    if (hadFocus) this.#retry.focus();
    this.#emit('bc-error', { error: code });
    this.#opts.errorCallback?.(code);
  }

  #stopWork(): void {
    this.#job?.cancel();
    this.#job = undefined;
    if (this.#expiry !== undefined) clearTimeout(this.#expiry);
    this.#expiry = undefined;
  }

  #setToken(token: string): void {
    this.#token = token;
    this.#input.value = token;
  }

  #say(key?: StringKey, kind: StatusKind = 'info'): void {
    this.#spinner.hidden = kind !== 'busy';
    this.#status.dataset.kind = key ? kind : '';
    if (!key) {
      this.#statusText.textContent = '';
      return;
    }
    const s = t(this.lang, key);
    this.#statusText.lang = s.lang;
    this.#statusText.textContent = s.text;
  }

  #hasFocus(): boolean {
    return this.#root.activeElement !== null;
  }

  #emit<K extends keyof WidgetEvents>(type: K, detail: WidgetEvents[K]): void {
    this.host.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
