// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from './i18n.js';
import { mainThreadSolver } from './pow.js';
import { getResponse, optionsFromElement, render, renderAll, reset } from './registry.js';
import { FakeApi, makeChallenge, makeFallback, powNumber, until } from './test-helpers.js';
import { CaptchaWidget, RESPONSE_FIELD, type RenderOptions } from './widget.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(api: FakeApi, opts: Partial<RenderOptions> = {}) {
  const form = document.createElement('form');
  const host = document.createElement('div');
  form.append(host);
  document.body.append(form);
  const w = new CaptchaWidget(host, {
    sitekey: 'test-sitekey',
    api: 'https://api.test',
    lang: 'en',
    fetch: api.fetch,
    solver: mainThreadSolver,
    ...opts,
  });
  const root = host.shadowRoot as ShadowRoot;
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T & Element>(sel);
  const all = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  const status = () => q('[role="status"]')?.textContent ?? '';
  const radios = () => all('[role="radio"]');
  const input = form.querySelector<HTMLInputElement>(`input[name="${RESPONSE_FIELD}"]`);
  const ready = () => until(() => radios().length > 0);
  return { form, host, w, root, q, all, status, radios, input, ready };
}

/** The body of the i-th /solve call. */
function solveBody(api: FakeApi, i: number) {
  return (api.solves()[i]?.body ?? {}) as { sealed?: string; answer?: string[]; pow?: string };
}

const key = (target: Element, k: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('rendering and accessibility', () => {
  it('builds a labelled group, a radiogroup named by the prompt, and a polite live region', async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.ready();
    const group = m.q('[role="group"]');
    expect(m.q(`#${group?.getAttribute('aria-labelledby')}`)?.textContent).toBe('Human check');
    const rg = m.q('[role="radiogroup"]');
    const prompt = m.q(`#${rg?.getAttribute('aria-labelledby')}`);
    expect(prompt?.textContent).toMatch(/^SYNTHETIC prompt/);
    expect(prompt?.getAttribute('lang')).toBe('be');
    const live = m.q('[role="status"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.getAttribute('aria-atomic')).toBe('true');
    expect(m.radios()).toHaveLength(4);
    expect(m.radios().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(m.radios().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('adds an empty hidden bc-response input to the form and does not take focus on load', async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.ready();
    expect(m.input?.type).toBe('hidden');
    expect(m.input?.value).toBe('');
    expect(m.root.activeElement).toBeNull();
    expect(new FormData(m.form).get(RESPONSE_FIELD)).toBe('');
  });

  it('asks the API with the site key, language and action', async () => {
    const api = new FakeApi();
    const m = mount(api, { action: 'comment', script: 'cyrl', types: 'proverb' });
    await m.ready();
    expect(Object.fromEntries(api.calls[0]?.url.searchParams ?? [])).toEqual({
      sitekey: 'test-sitekey',
      lang: 'en',
      script: 'cyrl',
      types: 'proverb',
      action: 'comment',
    });
  });

  it('sets the theme on the host', () => {
    const m = mount(new FakeApi(), { theme: 'dark' });
    expect(m.host.dataset.theme).toBe('dark');
  });

  it('refuses a missing site key and a second widget on one element', () => {
    const host = document.createElement('div');
    expect(() => new CaptchaWidget(host, { sitekey: '' })).toThrow(/sitekey/);
    const m = mount(new FakeApi());
    expect(() => new CaptchaWidget(m.host, { sitekey: 'x', fetch: new FakeApi().fetch })).toThrow(
      /already/,
    );
  });
});

describe('solving', () => {
  it('a click on the right ending solves the PoW, posts /solve and fills the form', async () => {
    const api = new FakeApi();
    api.solveReplies.push({
      status: 200,
      body: { token: 'pass-token', expires: Date.now() + 300_000 },
    });
    const callback = vi.fn();
    const solved = vi.fn();
    const m = mount(api, { callback });
    m.host.addEventListener('bc-solved', (e) => solved((e as CustomEvent).detail));
    await m.ready();
    const ch = api.challenges().length;
    m.radios()[1]?.click();
    await until(() => m.input?.value === 'pass-token');
    const body = api.solves()[0]?.body as { sealed: string; answer: string[]; pow: string };
    expect(body.answer).toEqual(['r0']);
    expect(body.sealed).toMatch(/^sealed-/);
    expect(powNumber(body)).toBe(32);
    expect(callback).toHaveBeenCalledWith('pass-token');
    expect(solved.mock.calls[0]?.[0]).toMatchObject({ token: 'pass-token' });
    expect(m.status()).toBe('Done');
    expect(m.q('[role="status"]')?.dataset.kind).toBe('ok');
    expect(m.radios()).toHaveLength(0);
    expect(m.w.getResponse()).toBe('pass-token');
    expect(new FormData(m.form).get(RESPONSE_FIELD)).toBe('pass-token');
    expect(api.challenges()).toHaveLength(ch);
  });

  it('keyboard: arrows move focus without picking; Enter picks and submits', async () => {
    const api = new FakeApi();
    api.solveReplies.push({
      status: 200,
      body: { token: 'kbd-token', expires: Date.now() + 300_000 },
    });
    const m = mount(api);
    await m.ready();
    const [a, b, , d] = m.radios() as HTMLElement[];
    a?.focus();
    key(a as HTMLElement, 'ArrowDown');
    expect(m.root.activeElement).toBe(b);
    expect(m.radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(b?.getAttribute('aria-checked')).toBe('false');
    key(b as HTMLElement, 'End');
    expect(m.root.activeElement).toBe(d);
    key(d as HTMLElement, 'ArrowDown');
    expect(m.root.activeElement).toBe(a);
    key(a as HTMLElement, 'ArrowUp');
    expect(m.root.activeElement).toBe(d);
    key(d as HTMLElement, 'Home');
    key(a as HTMLElement, 'ArrowRight');
    expect(api.solves()).toHaveLength(0);
    key(b as HTMLElement, 'Enter');
    expect(b?.getAttribute('aria-checked')).toBe('true');
    await until(() => m.input?.value === 'kbd-token');
    expect(solveBody(api, 0).answer).toEqual(['r0']);
    // Focus stays inside the widget after the options are replaced.
    expect(m.root.activeElement).not.toBeNull();
  });

  it('Space picks too, and other keys are ignored', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 't', expires: Date.now() + 300_000 } });
    const m = mount(api);
    await m.ready();
    const c = m.radios()[2] as HTMLElement;
    expect(key(c, 'x')).toBe(true);
    expect(c.getAttribute('aria-checked')).toBe('false');
    expect(key(c, ' ')).toBe(false);
    await until(() => api.solves().length === 1);
    expect(solveBody(api, 0).answer).toEqual(['w0b']);
  });

  it('two questions: submits only when both have an answer, in question order', async () => {
    const api = new FakeApi();
    api.challengeReplies.push({ status: 200, body: await makeChallenge(2) });
    api.solveReplies.push({ status: 200, body: { token: 't2', expires: Date.now() + 300_000 } });
    const m = mount(api);
    await m.ready();
    const groups = m.all('[role="radiogroup"]');
    expect(groups).toHaveLength(2);
    groups[1]?.querySelector<HTMLElement>('[data-id="r1"]')?.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.solves()).toHaveLength(0);
    groups[0]?.querySelector<HTMLElement>('[data-id="w0a"]')?.click();
    await until(() => m.input?.value === 't2');
    expect(solveBody(api, 0).answer).toEqual(['w0a', 'r1']);
  });

  it('a wrong answer shows the next challenge, announces it, and leaves the form empty', async () => {
    const api = new FakeApi();
    const next = await makeChallenge();
    api.solveReplies.push({ status: 422, body: { error: 'wrong-answer', next } });
    const rejected = vi.fn();
    const m = mount(api);
    m.host.addEventListener('bc-rejected', (e) => rejected((e as CustomEvent).detail));
    await m.ready();
    m.radios()[0]?.click();
    await until(() => m.status() === 'Not quite. Here is a new question.');
    expect(rejected).toHaveBeenCalledWith({ error: 'wrong-answer' });
    expect(m.input?.value).toBe('');
    expect(m.q('.prompt')?.textContent).toBe(next.display.questions[0]?.prompt);
    expect(m.radios().every((r) => r.getAttribute('aria-disabled') === null)).toBe(true);
    // The next challenge is answered with its own seal.
    api.solveReplies.push({
      status: 200,
      body: { token: 'second', expires: Date.now() + 300_000 },
    });
    m.radios()[1]?.click();
    await until(() => m.input?.value === 'second');
    expect(solveBody(api, 1).sealed).toBe(next.sealed);
  });

  it('an expired challenge says so and shows the next one', async () => {
    const api = new FakeApi();
    api.solveReplies.push({
      status: 422,
      body: { error: 'timeout-or-duplicate', next: await makeChallenge() },
    });
    const m = mount(api);
    await m.ready();
    m.radios()[1]?.click();
    await until(() => m.status() === 'The check expired. Here is a new question.');
  });

  it('ignores picks while a solve is in flight', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 't', expires: Date.now() + 300_000 } });
    const m = mount(api);
    await m.ready();
    m.radios()[1]?.click();
    m.radios()[2]?.click();
    await until(() => m.input?.value === 't');
    expect(api.solves()).toHaveLength(1);
  });
});

describe('failures', () => {
  it('says when the API cannot be reached, calls the error callback, and retries', async () => {
    const api = new FakeApi();
    api.challengeReplies.push('network-error');
    const errorCallback = vi.fn();
    const m = mount(api, { errorCallback });
    await until(() => errorCallback.mock.calls.length === 1);
    expect(errorCallback).toHaveBeenCalledWith('network-error');
    expect(m.status()).toBe(t('en', 'unreachable').text);
    expect(m.q('[role="status"]')?.dataset.kind).toBe('error');
    const retry = m.q<HTMLButtonElement>('button');
    expect(retry?.hidden).toBe(false);
    retry?.click();
    await m.ready();
    expect(retry?.hidden).toBe(true);
    expect(m.status()).toBe('');
  });

  it('rate-limited: says to wait', async () => {
    const api = new FakeApi();
    api.challengeReplies.push({ status: 429, body: { error: 'rate-limited' } });
    const m = mount(api);
    await until(() => m.status() === t('en', 'rateLimited').text);
  });

  it('a solve refused without a next challenge is a failure with a retry button', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 403, body: { error: 'hostname-mismatch' } });
    const errorCallback = vi.fn();
    const m = mount(api, { errorCallback });
    await m.ready();
    m.radios()[1]?.click();
    await until(() => errorCallback.mock.calls.length === 1);
    expect(errorCallback).toHaveBeenCalledWith('hostname-mismatch');
    expect(m.status()).toBe(t('en', 'failed').text);
    expect(m.radios()).toHaveLength(0);
  });

  it('the network failing during /solve is reported as unreachable', async () => {
    const api = new FakeApi();
    api.solveReplies.push('network-error');
    const m = mount(api);
    await m.ready();
    m.radios()[1]?.click();
    await until(() => m.status() === t('en', 'unreachable').text);
  });

  it('a PoW that finds nothing fails the check (pow-failed)', async () => {
    const api = new FakeApi();
    const errorCallback = vi.fn();
    const m = mount(api, {
      errorCallback,
      solver: () => ({ result: Promise.resolve(null), cancel() {} }),
    });
    await m.ready();
    m.radios()[0]?.click();
    await until(() => errorCallback.mock.calls.length === 1);
    expect(errorCallback).toHaveBeenCalledWith('pow-failed');
    expect(api.solves()).toHaveLength(0);
  });
});

describe('the fallback: "I cannot do this challenge" (D3 option B)', () => {
  const cannot = (m: ReturnType<typeof mount>) =>
    m.all('button').find((b) => b.textContent === t('en', 'cannot').text) as
      | HTMLButtonElement
      | undefined;

  it('shows the button with a question, keyboard-reachable, and hides it otherwise', async () => {
    const api = new FakeApi();
    api.challengeReplies.push('network-error');
    const m = mount(api);
    await until(() => m.status() === t('en', 'unreachable').text);
    expect(cannot(m)?.hidden).toBe(true);
    m.w.reset();
    await m.ready();
    const b = cannot(m);
    expect(b?.hidden).toBe(false);
    expect(b?.type).toBe('button');
    expect(b?.tabIndex).toBe(0);
    expect(b?.getAttribute('lang')).toBe('en');
  });

  it('drops the question, solves the harder PoW, sends an empty answer and fills the form', async () => {
    const api = new FakeApi();
    api.fallbackReplies.push({ status: 200, body: await makeFallback(256) });
    api.solveReplies.push({
      status: 200,
      body: { token: 'fallback-token', expires: Date.now() + 300_000 },
    });
    const callback = vi.fn();
    const seen: { type: string; questions: number }[] = [];
    const m = mount(api, { callback, action: 'signup' });
    m.host.addEventListener('bc-challenge', (e) => seen.push((e as CustomEvent).detail));
    await m.ready();
    cannot(m)?.focus();
    cannot(m)?.click();
    expect(m.radios()).toHaveLength(0);
    expect(m.status()).toBe(t('en', 'checkingLonger').text);
    // Focus stays inside the widget when the button disappears.
    expect(m.root.activeElement).not.toBeNull();
    await until(() => m.input?.value === 'fallback-token');
    expect(callback).toHaveBeenCalledWith('fallback-token');
    expect(Object.fromEntries(api.fallbacks()[0]?.url.searchParams ?? [])).toEqual({
      sitekey: 'test-sitekey',
      lang: 'en',
      action: 'signup',
    });
    const body = solveBody(api, 0);
    expect(body.answer).toEqual([]);
    expect(powNumber(body)).toBe(128);
    expect(seen.map((d) => [d.type, d.questions])).toEqual([
      ['proverb', 1],
      ['fallback', 0],
    ]);
    expect(m.status()).toBe(t('en', 'done').text);
    expect(cannot(m)?.hidden).toBe(true);
  });

  it('a refused fallback is a failure; "Try again" brings a question and the button back', async () => {
    const api = new FakeApi();
    api.solveReplies.push({
      status: 422,
      body: { error: 'bad-pow', next: await makeFallback() },
    });
    const errorCallback = vi.fn();
    const m = mount(api, { errorCallback });
    await m.ready();
    cannot(m)?.click();
    await until(() => errorCallback.mock.calls.length === 1);
    expect(errorCallback).toHaveBeenCalledWith('bad-pow');
    expect(m.status()).toBe(t('en', 'failed').text);
    expect(cannot(m)?.hidden).toBe(true);
    m.q<HTMLButtonElement>('button')?.click();
    await m.ready();
    expect(cannot(m)?.hidden).toBe(false);
    expect(api.challenges()).toHaveLength(2);
  });

  it('the fallback endpoint failing is reported like any other', async () => {
    const api = new FakeApi();
    api.fallbackReplies.push({ status: 429, body: { error: 'rate-limited' } });
    const m = mount(api);
    await m.ready();
    cannot(m)?.click();
    await until(() => m.status() === t('en', 'rateLimited').text);
    expect(api.solves()).toHaveLength(0);
  });

  it('a pick no longer counts once the fallback has started', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 'fb', expires: Date.now() + 300_000 } });
    const m = mount(api);
    await m.ready();
    const radio = m.radios()[1];
    cannot(m)?.click();
    radio?.click();
    await until(() => m.input?.value === 'fb');
    expect(api.solves()).toHaveLength(1);
    expect(solveBody(api, 0).answer).toEqual([]);
  });
});

describe('"Report this question" (section 11)', () => {
  const reportButtons = (m: ReturnType<typeof mount>) => m.all('button.report');

  it('puts one report button under each question, described by its prompt', async () => {
    const api = new FakeApi();
    api.challengeReplies.push({ status: 200, body: await makeChallenge(2) });
    const m = mount(api);
    await m.ready();
    const buttons = reportButtons(m);
    expect(buttons.map((b) => b.textContent)).toEqual([
      t('en', 'report').text,
      t('en', 'report').text,
    ]);
    const prompts = m.all('.prompt');
    expect(buttons.map((b) => b.getAttribute('aria-describedby'))).toEqual(
      prompts.map((p) => p.id),
    );
    expect(buttons.every((b) => (b as HTMLButtonElement).type === 'button')).toBe(true);
  });

  it('sends only the seal and the question index, says thank you, and sends once', async () => {
    const api = new FakeApi();
    const c = await makeChallenge(2);
    api.challengeReplies.push({ status: 200, body: c });
    const m = mount(api);
    const events: unknown[] = [];
    m.host.addEventListener('bc-reported', (e) => events.push((e as CustomEvent).detail));
    await m.ready();
    const b = reportButtons(m)[1] as HTMLButtonElement;
    b.click();
    await until(() => m.status() === t('en', 'reported').text);
    expect(api.reports().map((r) => [r.method, r.body])).toEqual([
      ['POST', { sealed: c.sealed, question: 1 }],
    ]);
    expect(b.textContent).toBe(t('en', 'reported').text);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(events).toEqual([{ question: 1 }]);
    b.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.reports()).toHaveLength(1);
    // The check goes on: the question is still there and can be answered.
    expect(m.radios()).toHaveLength(8);
    expect(m.input?.value).toBe('');
  });

  it('a report that fails says so and does not stop the check', async () => {
    const api = new FakeApi();
    api.reportReplies.push({ status: 403, body: { error: 'hostname-mismatch' } });
    api.solveReplies.push({ status: 200, body: { token: 'tr', expires: Date.now() + 300_000 } });
    const errors: string[] = [];
    const m = mount(api, { errorCallback: (c) => errors.push(c) });
    await m.ready();
    reportButtons(m)[0]?.click();
    await until(() => m.status() === t('en', 'reportFailed').text);
    expect(errors).toEqual([]);
    m.q('[data-id="r0"]')?.click();
    await until(() => m.input?.value === 'tr');
  });

  it('a report answered after the next challenge arrived changes nothing on screen', async () => {
    const api = new FakeApi();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = api.fetch;
    const m = mount(api, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/report')) await gate;
        return slow(input, init);
      }) as typeof fetch,
    });
    await m.ready();
    reportButtons(m)[0]?.click();
    m.w.reset();
    await until(() => api.challenges().length === 2 && m.radios().length === 4);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(m.status()).toBe('');
    expect(reportButtons(m)[0]?.textContent).toBe(t('en', 'report').text);
  });
});

describe('token lifetime and reset', () => {
  it('clears the token when it expires, calls the expired callback, and loads a new challenge', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 'short', expires: Date.now() + 50 } });
    const expiredCallback = vi.fn();
    const m = mount(api, { expiredCallback });
    await m.ready();
    m.radios()[1]?.click();
    await until(() => m.input?.value === 'short');
    await until(() => expiredCallback.mock.calls.length === 1);
    expect(m.input?.value).toBe('');
    await m.ready();
    expect(m.status()).toBe(t('en', 'expired').text);
    expect(api.challenges()).toHaveLength(2);
  });

  it('reset() drops the token and fetches a new challenge; destroy() removes the input', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 'x', expires: Date.now() + 300_000 } });
    const m = mount(api);
    await m.ready();
    m.radios()[1]?.click();
    await until(() => m.w.getResponse() === 'x');
    m.w.reset();
    expect(m.w.getResponse()).toBe('');
    await m.ready();
    expect(api.challenges()).toHaveLength(2);
    m.w.destroy();
    expect(m.form.querySelector(`input[name="${RESPONSE_FIELD}"]`)).toBeNull();
    expect(m.root.childNodes).toHaveLength(0);
  });

  it('a reset while a challenge is loading wins over the stale answer', async () => {
    const api = new FakeApi();
    const first = await makeChallenge();
    const second = await makeChallenge();
    api.challengeReplies.push({ status: 200, body: first }, { status: 200, body: second });
    const m = mount(api);
    m.w.reset();
    await m.ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(m.q('.prompt')?.textContent).toBe(second.display.questions[0]?.prompt);
  });
});

describe('languages', () => {
  it('be uses the strings in be.json and falls back to English, marked lang="en"', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 't', expires: Date.now() + 300_000 } });
    const m = mount(api, { lang: 'be' });
    await m.ready();
    expect(m.q('[role="group"]')?.getAttribute('lang')).toBe('be');
    expect(m.q('#bc-title')?.getAttribute('lang')).toBe('en');
    m.radios()[1]?.click();
    await until(() => m.input?.value === 't');
    expect(m.status()).toBe('Гатова');
    expect(m.q('[role="status"] span:last-child')?.getAttribute('lang')).toBe('be');
  });

  it('an unknown language falls back to be (the default)', () => {
    const m = mount(new FakeApi(), { lang: 'xx' });
    expect(m.w.lang).toBe('be');
  });

  it('every language has every key, or falls back to a non-empty English string', () => {
    for (const lang of ['be', 'be-Latn', 'ru', 'en'] as const) {
      for (const k of ['label', 'instruction', 'checking', 'done', 'wrong', 'retry'] as const) {
        expect(t(lang, k).text.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('data-* embed and the JS API', () => {
  it('reads options from data attributes, with named global callbacks', async () => {
    const el = document.createElement('div');
    el.className = 'belarusian-captcha';
    Object.assign(el.dataset, {
      sitekey: 'sk',
      api: 'https://api.test',
      lang: 'ru',
      theme: 'light',
      action: 'login',
      callback: 'onBcToken',
      errorCallback: 'onBcError',
    });
    const seen = vi.fn();
    (globalThis as Record<string, unknown>).onBcToken = seen;
    const o = optionsFromElement(el);
    expect(o).toMatchObject({
      sitekey: 'sk',
      api: 'https://api.test',
      lang: 'ru',
      action: 'login',
    });
    expect(o.expiredCallback).toBeUndefined();
    o.callback?.('tok');
    expect(seen).toHaveBeenCalledWith('tok');
    o.errorCallback?.('network-error'); // not defined: ignored
    delete (globalThis as Record<string, unknown>).onBcToken;
  });

  it('renderAll renders each element once; reset() and getResponse() act on the first', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 'first', expires: Date.now() + 300_000 } });
    vi.stubGlobal('fetch', api.fetch);
    document.body.innerHTML =
      '<form><div class="belarusian-captcha" data-sitekey="sk" data-api="https://api.test" data-lang="en"></div></form>' +
      '<div class="belarusian-captcha"></div>';
    const made = renderAll(document);
    expect(made).toHaveLength(1);
    expect(renderAll(document)).toHaveLength(0);
    const root = made[0]?.host.shadowRoot as ShadowRoot;
    await until(() => root.querySelectorAll('[role="radio"]').length > 0);
    root.querySelectorAll<HTMLElement>('[role="radio"]')[1]?.click();
    await until(() => getResponse() === 'first');
    reset();
    expect(getResponse()).toBe('');
    vi.unstubAllGlobals();
  });

  it('render() accepts a selector and fails clearly when nothing matches', () => {
    document.body.innerHTML = '<div id="cap"></div>';
    const w = render('#cap', {
      sitekey: 'sk',
      fetch: new FakeApi().fetch,
      api: 'https://api.test',
    });
    expect(w.host.id).toBe('cap');
    expect(() => render('#nope', { sitekey: 'sk' })).toThrow(/no element/);
  });
});
