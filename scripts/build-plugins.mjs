import path from 'node:path';
import * as esbuild from 'esbuild';
import { ROOT, pluginBuildConfigs } from './esbuild-config.mjs';

const configs = await pluginBuildConfigs();
if (configs.length === 0) {
  console.warn('[plugins] nothing to build');
} else {
  await Promise.all(configs.map(async ({ id, options }) => {
    await esbuild.build(options);
    console.log(`[plugins] built ${id} -> ${path.relative(ROOT, options.outfile)}`);
  }));
}
