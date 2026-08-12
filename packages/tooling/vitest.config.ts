import { defineConfig } from 'vitest/config';

// As in `@wc/bots`: the sources, so a stale `dist` cannot skew a match.
export default defineConfig({
  resolve: {
    alias: {
      '@wc/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
      '@wc/bots': new URL('../bots/src/index.ts', import.meta.url).pathname,
    },
  },
});
