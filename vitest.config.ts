import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // The real-CLI surface check needs `codex` and `claude` on PATH; it lives in `npm run test:agents`
    // (vitest.agents.config.ts) so that `npm test` stays offline and identical on every machine.
    exclude: ['node_modules', 'dist', '.orchestrator', 'test/integration/agent-surface.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Glyph selection is a guess about the terminal, and the runner's terminal varies. Pin it so expected
    // output is the same everywhere; the tests that cover the ASCII fallback override this themselves.
    env: { CAO_UNICODE: '1' },
  },
  oxc: { jsx: { runtime: 'automatic' } },
});
