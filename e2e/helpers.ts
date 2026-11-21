// Shared by the end-to-end specs: the demo address and the question the widget shows, with its
// right and a wrong option (the right ending comes from the SYNTHETIC test pack).

import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { API, SITEKEY } from './env.js';

const pack = JSON.parse(
  readFileSync(new URL('../server/test/fixtures/synthetic-pack.json', import.meta.url), 'utf8'),
) as { items: { cut: string; ending: string; status: string }[] };
export const endingOf = new Map(pack.items.map((i) => [i.cut, i.ending]));

export type Lang = 'en' | 'be' | 'be-Latn' | 'ru';
export type Theme = 'auto' | 'light' | 'dark';

export const demoUrl = (opts: { api?: string; lang?: Lang; theme?: Theme } = {}): string =>
  `/?${new URLSearchParams({
    api: opts.api ?? API,
    sitekey: SITEKEY,
    lang: opts.lang ?? 'en',
    theme: opts.theme ?? 'light',
  })}`;

/** The prompt shown, and the right and a wrong option for it. */
export async function question(page: Page) {
  const widget = page.locator('#captcha');
  const radios = widget.getByRole('radio');
  await expect(radios).toHaveCount(4);
  const prompt = (await widget.locator('.prompt').first().textContent()) ?? '';
  const right = endingOf.get(prompt) ?? '';
  expect(right, `prompt "${prompt}" is in the synthetic pack`).not.toBe('');
  const texts = await radios.allTextContents();
  const wrong = texts.find((t) => t !== right) as string;
  return {
    widget,
    prompt,
    right: widget.getByRole('radio', { name: right, exact: true }),
    wrong: widget.getByRole('radio', { name: wrong, exact: true }),
  };
}
