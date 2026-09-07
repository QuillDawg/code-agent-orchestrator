import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', '.orchestrator'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Glyph selection is a guess about the terminal, and the runner's terminal varies. Pin it so expected
    // output is the same everywhere; the tests that cover the ASCII fallback override this themselves.
    env: { CAO_UNICODE: '1' },
  },
  esbuild: { jsx: 'automatic' },
});
