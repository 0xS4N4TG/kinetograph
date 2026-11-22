import { configDefaults, defineConfig } from 'vitest/config';

// The files that start studios on the default engine: each of its workers loads the core and the addon, several
// seconds of CPU apiece. Alone they take a few seconds; beside the other files, which all run at once, the same tests
// took 20 to 30 s and timed out. They run as a group of their own, after the rest.
const REAL_ENGINE = ['test/real-engine.test.ts', 'test/audio.test.ts'];

// The UI (`ui/`) is its own workspace with its own jsdom tests; this package tests the server only.
export default defineConfig({
  test: {
    // Every test's temp dirs go in a directory of the run's own, under /tmp (scripts/vitest-temp-dir.mjs).
    globalSetup: ['../../scripts/vitest-temp-dir.mjs'],
    projects: [
      { extends: true, test: { name: 'stub engine', include: ['test/**/*.test.ts'], exclude: [...configDefaults.exclude, ...REAL_ENGINE] } },
      { extends: true, test: { name: 'default engine', include: REAL_ENGINE, sequence: { groupOrder: 1 } } },
    ],
  },
});
