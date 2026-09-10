import { defineConfig } from 'vitest/config';

/**
 * `npm run test:agents`: the checks that need the real agent CLIs on PATH. They are kept out of
 * `npm test` (see vitest.config.ts) so the default suite stays offline and independent of what is
 * installed; each check skips with a stated reason when its binary is missing or too old.
 */
export default defineConfig({
  test: {
    include: ['test/integration/agent-surface.test.ts'],
    exclude: ['node_modules', 'dist', '.orchestrator'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    env: { CAO_UNICODE: '1' },
  },
});
