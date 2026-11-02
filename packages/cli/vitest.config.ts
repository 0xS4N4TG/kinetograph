import { defineConfig } from 'vitest/config';

// Many tests bundle a project or render frames; under load those take well over vitest's 5 s default. Files that
// need longer still set their own with `vi.setConfig`.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000,
    // No test asks the npm registry; the update-notice tests turn the notices back on with their own cache and fetch.
    env: { KINETOGRAPH_NO_UPDATE_CHECK: '1' },
  },
});
