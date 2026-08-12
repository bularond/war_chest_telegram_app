import { defineConfig } from 'vitest/config';

// The worker pool starts real threads, which need real modules: these tests run
// against the built `dist` of the other packages, not their sources.
export default defineConfig({
  test: { testTimeout: 20_000 },
});
