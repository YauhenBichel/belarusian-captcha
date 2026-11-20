import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// One run covers every workspace package (shared/, server/, ...): tests live next to the code.
export default defineConfig({
  resolve: {
    // Tests run against the shared sources, so no build is needed first.
    alias: {
      '@belarusian-captcha/shared': fileURLToPath(
        new URL('./shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['**/src/**/*.test.ts', '**/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // `npm run coverage`: v8 coverage of the package sources. The floor sits a little below
    // today's numbers, so a change that drops tested code fails while ordinary edits do not.
    coverage: {
      provider: 'v8',
      include: ['shared/src/**/*.ts', 'server/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test-helpers.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, statements: 82, functions: 80, branches: 75 },
    },
  },
});
