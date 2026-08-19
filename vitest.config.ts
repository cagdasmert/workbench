import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Source only. `tsc -b` also emits compiled tests into .tsbuild/, and without
    // this vitest runs every suite twice — once from source, once from output.
    include: ['packages/*/src/**/*.test.ts'],
  },
});
