import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  // No sourcemaps in the published build: they are the largest thing in the tarball and the bundle is
  // not what anyone debugs — a contributor runs `npm run dev` (tsx over src/) instead.
  sourcemap: false,
  clean: true,
  dts: { entry: { index: 'src/index.ts' } },
  banner: ({ format }) => (format === 'esm' ? { js: '' } : {}),
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
