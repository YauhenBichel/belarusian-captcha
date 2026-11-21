// End to end: the demo page and the verify API from source (docs/DESIGN.md section 8.2).
// challenge -> PoW (in the Web Worker) -> solve -> siteverify accepts once and refuses a replay;
// a wrong answer gets no token and siteverify refuses; an unreachable API is said plainly.
//
// The test plays the visitor in the browser and the site's backend through `request` (the only
// place the test secret is used). It knows the right ending from the SYNTHETIC test pack.

import { expect, test } from '@playwright/test';
import { API, SECRET } from './env.js';
import { demoUrl, endingOf, question } from './helpers.js';

async function siteverify(response: string) {
  const res = await fetch(`${API}/api/v1/siteverify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, response }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { success: boolean; hostname?: string; 'error-codes': string[] };
}

test('challenge, PoW in a worker, solve, siteverify accepts once and refuses a replay', async ({
  page,
}) => {
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto(demoUrl());
  await expect(page.locator('#api-status')).toHaveAttribute('data-state', 'ok');
  const q = await question(page);
  await q.right.click();

  await expect(q.widget.getByRole('status')).toHaveText('Done');
  const token = await page.locator('input[name="bc-response"]').inputValue();
  expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(workers.some((u) => u.endsWith('/widget.worker.js'))).toBe(true);
  await expect(page.locator('#events')).toContainText('solved');

  const first = await siteverify(token);
  expect(first).toMatchObject({ success: true, hostname: '127.0.0.1', 'error-codes': [] });
  const replay = await siteverify(token);
  expect(replay).toEqual({ success: false, 'error-codes': ['timeout-or-duplicate'] });

  // The page's own CSP (meta tag) allowed everything the widget does.
  expect(consoleErrors).toEqual([]);
});

test('keyboard only: Tab into the options, arrows move, Enter picks', async ({ page }) => {
  await page.goto(demoUrl());
  const q = await question(page);
  const radios = q.widget.getByRole('radio');
  await page.locator('#comment').focus();
  await page.keyboard.press('Tab');
  await expect(radios.first()).toBeFocused();
  const texts = await radios.allTextContents();
  const right = texts.indexOf(endingOf.get(q.prompt) as string);
  for (let i = 0; i < right; i++) await page.keyboard.press('ArrowDown');
  await expect(radios.nth(right)).toBeFocused();
  await expect(radios.nth(right)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Enter');
  await expect(q.widget.getByRole('status')).toHaveText('Done');
  const token = await page.locator('input[name="bc-response"]').inputValue();
  expect((await siteverify(token)).success).toBe(true);
});

test('a wrong answer gets no token, a new question, and siteverify refuses', async ({ page }) => {
  await page.goto(demoUrl());
  const q = await question(page);
  await q.wrong.click();

  await expect(q.widget.getByRole('status')).toHaveText('Not quite. Here is a new question.');
  await expect(q.widget.getByRole('radio')).toHaveCount(4);
  await expect(page.locator('#events')).toContainText('rejected: wrong-answer');
  const token = await page.locator('input[name="bc-response"]').inputValue();
  expect(token).toBe('');

  const refused = await siteverify(token);
  expect(refused).toEqual({ success: false, 'error-codes': ['invalid-input-response'] });
  // A made-up token is refused as well.
  const forged = await siteverify('k1.eyJ0aWQiOiJ4In0.AAAA');
  expect(forged.success).toBe(false);
});

test('"I cannot do this challenge" by keyboard: a low-score pass marked as a fallback', async ({
  page,
}) => {
  await page.goto(demoUrl());
  const q = await question(page);
  const cannot = q.widget.getByRole('button', { name: 'I cannot do this challenge' });
  await expect(cannot).toBeVisible();
  // Tab past the radio group (one tab stop) to the button, then Enter.
  await q.widget.getByRole('radio').first().focus();
  await page.keyboard.press('Tab');
  await expect(cannot).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(q.widget.getByRole('radio')).toHaveCount(0);
  await expect(q.widget.getByRole('status')).toHaveText('Done');
  const token = await page.locator('input[name="bc-response"]').inputValue();
  const v = await siteverify(token);
  expect(v).toMatchObject({ success: true, score: 0.3, fallback: true, 'error-codes': [] });
});

test('the page says clearly when the API cannot be reached', async ({ page }) => {
  await page.goto(demoUrl({ api: 'http://127.0.0.1:9' }));
  const banner = page.locator('#api-status');
  await expect(banner).toHaveAttribute('data-state', 'down');
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText('The demo API cannot be reached.');
  await expect(banner).toContainText('http://127.0.0.1:9');
});
