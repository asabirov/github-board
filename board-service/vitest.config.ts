import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    clearMocks: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
    // Hooks are NOT governed by testTimeout. `writes-enveloped.spec.ts` builds a
    // ts.Program in `beforeAll` (~1s standalone, ~2s pinned to two threads), so
    // without this the stated 30s budget was really vitest's 10s hook default.
    hookTimeout: 30000,
  },
});
