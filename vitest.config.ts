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
    include: ['**/src/**/*.test.ts', '**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
