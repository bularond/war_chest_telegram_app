import { defineConfig } from 'vitest/config';

// Tests run against the sources of the other packages, not their `dist`, so a
// stale build cannot turn into a mysteriously failing (or passing) test.
export default defineConfig({
  resolve: {
    alias: { '@wc/shared': new URL('../shared/src/index.ts', import.meta.url).pathname },
  },
});
