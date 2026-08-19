import path from 'node:path';
import * as esbuild from 'esbuild';
import { ROOT, mainOptions, preloadOptions } from './esbuild-config.mjs';

for (const options of [preloadOptions, mainOptions]) {
  await esbuild.build(options);
  console.log(`[app] built ${path.relative(ROOT, options.outfile)}`);
}
