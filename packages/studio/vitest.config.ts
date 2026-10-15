import { defineConfig } from 'vitest/config';

// The UI (`ui/`) is its own workspace with its own jsdom tests; this package tests the server only.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
