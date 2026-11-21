import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, isChallenge } from './api.js';
import { FakeApi, makeChallenge, makeFallback } from './test-helpers.js';

describe('ApiClient.challenge', () => {
  it('sends the query, omits empty values, and returns the challenge', async () => {
    const api = new FakeApi();
    const c = new ApiClient('https://api.test/base/', api.fetch);
    const ch = await c.challenge({ sitekey: 'sk', lang: 'en', script: undefined, action: '' });
    expect(isChallenge(ch)).toBe(true);
    const url = api.calls[0]?.url;
    expect(url?.origin + (url?.pathname ?? '')).toBe('https://api.test/base/api/v1/challenge');
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({ sitekey: 'sk', lang: 'en' });
  });

  it('throws the API error code and status', async () => {
    const api = new FakeApi();
    api.challengeReplies.push({ status: 403, body: { error: 'invalid-sitekey' } });
    const err = await new ApiClient('https://api.test', api.fetch)
      .challenge({ sitekey: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'invalid-sitekey', status: 403 });
  });

  it('tells a network failure from an API error', async () => {
    const api = new FakeApi();
    api.challengeReplies.push('network-error');
    await expect(
      new ApiClient('https://api.test', api.fetch).challenge({ sitekey: 'x' }),
    ).rejects.toMatchObject({ code: 'network-error' });
  });

  it('rejects a 200 that is not a challenge, and an error without a code', async () => {
    const api = new FakeApi();
    api.challengeReplies.push({ status: 200, body: { sealed: 1 } }, { status: 502, body: 'x' });
    const c = new ApiClient('https://api.test', api.fetch);
    await expect(c.challenge({ sitekey: 'x' })).rejects.toMatchObject({ code: 'bad-response' });
    await expect(c.challenge({ sitekey: 'x' })).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('ApiClient.fallback', () => {
  it('asks GET /fallback and returns a challenge with no question', async () => {
    const api = new FakeApi();
    const ch = await new ApiClient('https://api.test', api.fetch).fallback({
      sitekey: 'sk',
      action: 'signup',
    });
    expect(ch.type).toBe('fallback');
    expect(ch.display.questions).toEqual([]);
    const url = api.calls[0]?.url;
    expect(url?.pathname).toBe('/api/v1/fallback');
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      sitekey: 'sk',
      action: 'signup',
    });
  });

  it('refuses a proverb from /fallback and a fallback from /challenge', async () => {
    const api = new FakeApi();
    api.fallbackReplies.push({ status: 200, body: await makeChallenge() });
    api.challengeReplies.push({ status: 200, body: await makeFallback() });
    const c = new ApiClient('https://api.test', api.fetch);
    await expect(c.fallback({ sitekey: 'x' })).rejects.toMatchObject({ code: 'bad-response' });
    await expect(c.challenge({ sitekey: 'x' })).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('ApiClient.solve', () => {
  const req = { sealed: 's', answer: ['a'], pow: 'p' };

  it('posts JSON and returns the token', async () => {
    const api = new FakeApi();
    api.solveReplies.push({ status: 200, body: { token: 't', expires: 5 } });
    const r = await new ApiClient('https://api.test', api.fetch).solve(req);
    expect(r).toEqual({ ok: true, token: 't', expires: 5 });
    expect(api.calls[0]?.method).toBe('POST');
    expect(api.calls[0]?.body).toEqual(req);
  });

  it('returns the error and the next challenge on 422', async () => {
    const api = new FakeApi();
    const next = await makeChallenge();
    api.solveReplies.push({ status: 422, body: { error: 'wrong-answer', next } });
    const r = await new ApiClient('https://api.test', api.fetch).solve(req);
    expect(r).toEqual({ ok: false, error: 'wrong-answer', next });
  });

  it('returns the error without next on 429, and bad-response on a broken 200', async () => {
    const api = new FakeApi();
    api.solveReplies.push(
      { status: 429, body: { error: 'rate-limited' } },
      { status: 200, body: { token: 1 } },
    );
    const c = new ApiClient('https://api.test', api.fetch);
    expect(await c.solve(req)).toEqual({ ok: false, error: 'rate-limited' });
    expect(await c.solve(req)).toEqual({ ok: false, error: 'bad-response' });
  });

  it('throws network-error when the API cannot be reached', async () => {
    const api = new FakeApi();
    api.solveReplies.push('network-error');
    await expect(new ApiClient('https://api.test', api.fetch).solve(req)).rejects.toMatchObject({
      code: 'network-error',
    });
  });
});

describe('isChallenge', () => {
  it('requires questions with string options for a proverb, and none for a fallback', async () => {
    const ch = await makeChallenge();
    expect(isChallenge(ch)).toBe(true);
    expect(isChallenge({ ...ch, display: { questions: [] } })).toBe(false);
    const fb = await makeFallback();
    expect(isChallenge(fb)).toBe(true);
    expect(isChallenge({ ...fb, display: ch.display })).toBe(false);
    expect(isChallenge({ ...ch, type: 'picture' })).toBe(false);
    expect(
      isChallenge({ ...ch, display: { questions: [{ prompt: 'p', options: [{ id: 1 }] }] } }),
    ).toBe(false);
    expect(isChallenge(null)).toBe(false);
  });
});
