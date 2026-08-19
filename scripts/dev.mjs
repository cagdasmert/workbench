import { spawn } from 'node:child_process';
import path from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { createServer } from 'vite';
import { ROOT, mainOptions, preloadOptions, pluginBuildConfigs } from './esbuild-config.mjs';

/**
 * Dev orchestrator. Owns every build in the dev loop so that the Electron main
 * process never has to: main watches build *output* only (Step 9), which makes
 * "build finished" causally precede "notify renderer" instead of racing it.
 */

const contexts = [];
let viteServer = null;
let electronProc = null;
let devServerUrl = '';

let armed = false;         // true once electron has been spawned
let restarting = false;
let shuttingDown = false;
let restartTimer = null;

// ── electron ───────────────────────────────────────────────────────

function startElectron() {
  electronProc = spawn(electronPath, [path.join(ROOT, 'packages/main/dist/index.js')], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
  });

  electronProc.on('exit', (code) => {
    electronProc = null;
    if (shuttingDown) return;
    if (restarting) {
      restarting = false;
      startElectron();
      return;
    }
    console.log(`\n[dev] electron quit (code ${code ?? 0}) — shutting down`);
    void shutdown(0);
  });
}

/** Debounced: a main+preload rebuild pair must not restart the app twice. */
function scheduleRestart(reason) {
  if (!armed || shuttingDown) return;
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    console.log(`[dev] ${reason} changed — restarting electron`);
    if (electronProc === null) {
      startElectron();
    } else {
      restarting = true;
      electronProc.kill();
    }
  }, 100);
}

// ── build watchers ─────────────────────────────────────────────────

function notify(label, onRebuild) {
  return {
    name: 'workbench-dev-notify',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) {
          console.error(`[dev] ${label} build failed:`);
          for (const e of result.errors) console.error('   ', e.text);
          return;
        }
        onRebuild();
      });
    },
  };
}

async function watch(label, options, onRebuild) {
  // esbuild's initial build finishes *after* ctx.watch() resolves, so a boot-time
  // flag cannot reliably suppress it. Counting per context can.
  let builds = 0;
  const ctx = await esbuild.context({
    ...options,
    plugins: [...(options.plugins ?? []), notify(label, () => {
      builds += 1;
      if (builds > 1) onRebuild();
    })],
  });
  contexts.push(ctx);
  await ctx.watch();
  return ctx;
}

// ── teardown ───────────────────────────────────────────────────────

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer !== null) clearTimeout(restartTimer);

  electronProc?.kill();
  await Promise.allSettled(contexts.map((c) => c.dispose()));
  await viteServer?.close().catch(() => undefined);

  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

// ── boot ───────────────────────────────────────────────────────────

await watch('preload', preloadOptions, () => scheduleRestart('preload'));
await watch('main', mainOptions, () => scheduleRestart('main'));

for (const { id, options } of await pluginBuildConfigs()) {
  // Plugin rebuilds deliberately do NOT restart electron — that would be a slow
  // app restart wearing hot reload's clothes. Main watches plugins/*/dist and
  // swaps the module in place (Step 9).
  await watch(`plugin:${id}`, options, () => console.log(`[dev] rebuilt plugin ${id}`));
}

viteServer = await createServer({
  configFile: path.join(ROOT, 'packages/shell/vite.config.ts'),
});
await viteServer.listen();
devServerUrl = viteServer.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';

console.log(`[dev] vite      ${devServerUrl}`);
console.log('[dev] watching  main · preload · plugins');

startElectron();
armed = true;
