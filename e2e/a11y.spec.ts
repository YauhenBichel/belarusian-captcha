// Accessibility (docs/DESIGN.md section 8.2): an axe-core scan of the demo page with the widget in
// every state a visitor meets (question, solved, a wrong answer, the fallback, an API that cannot be
// reached), in the four UI languages and the light, dark and auto themes. Zero violations of
// WCAG 2.0, 2.1 and 2.2 A and AA is the bar (the "axe clean" condition of phase 1). The widget's
// shadow root is open, so axe scans inside it.

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { demoUrl, type Lang, question, type Theme } from './helpers.js';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** Scans the whole page and fails with a readable list of what axe found. */
async function expectNoViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const found = violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
  expect(found, found.join('\n')).toEqual([]);
}

const LANGS: Lang[] = ['en', 'be', 'be-Latn', 'ru'];
const THEMES: Theme[] = ['light', 'dark'];

for (const lang of LANGS) {
  for (const theme of THEMES) {
    test(`the question, ${lang}, ${theme} theme`, async ({ page }) => {
      await page.goto(demoUrl({ lang, theme }));
      await question(page);
      await expectNoViolations(page);
    });
  }
}

test('the auto theme follows a dark system setting', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(demoUrl({ theme: 'auto' }));
  await question(page);
  await expectNoViolations(page);
});

test('solved', async ({ page }) => {
  await page.goto(demoUrl());
  const q = await question(page);
  await q.right.click();
  await expect(q.widget.getByRole('status')).toHaveText('Done');
  await expectNoViolations(page);
});

test('after a wrong answer', async ({ page }) => {
  await page.goto(demoUrl());
  const q = await question(page);
  await q.wrong.click();
  await expect(q.widget.getByRole('status')).toHaveText('Not quite. Here is a new question.');
  await expect(q.widget.getByRole('radio')).toHaveCount(4);
  await expectNoViolations(page);
});

test('the accessible fallback', async ({ page }) => {
  await page.goto(demoUrl());
  const q = await question(page);
  await q.widget.getByRole('button', { name: 'I cannot do this challenge' }).click();
  await expect(q.widget.getByRole('status')).toHaveText('Done');
  await expectNoViolations(page);
});

test('the API cannot be reached', async ({ page }) => {
  await page.goto(demoUrl({ api: 'http://127.0.0.1:9' }));
  await expect(page.locator('#api-status')).toHaveAttribute('data-state', 'down');
  await expectNoViolations(page);
});
