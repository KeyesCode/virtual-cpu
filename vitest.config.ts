import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each workspace is its own Vitest project; apps/web picks up its vite.config.ts.
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      reporter: ['text', 'html', 'json-summary'],
    },
  },
});
