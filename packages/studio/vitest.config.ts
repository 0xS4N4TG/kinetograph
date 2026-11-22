import { defineConfig } from 'vitest/config';

// The UI (`ui/`) is its own workspace with its own jsdom tests; this package tests the server only.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every test's temp dirs go in a directory of the run's own, under /tmp (scripts/vitest-temp-dir.mjs).
    globalSetup: ['../../scripts/vitest-temp-dir.mjs'],
  },
});
