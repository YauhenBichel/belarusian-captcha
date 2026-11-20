import { defineConfig } from 'vitest/config';

// One run covers every workspace package (shared/, server/, ...): tests live next to the code.
export default defineConfig({
  test: {
    include: ['**/src/**/*.test.ts', '**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
