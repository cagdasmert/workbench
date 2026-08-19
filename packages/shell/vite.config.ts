import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Explicit so dev.mjs can start Vite from the repo root.
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // strictPort: the dev CSP whitelists ws://localhost:5173 by name, so a silent
  // port bump would break HMR with a confusing CSP error.
  server: { port: 5173, strictPort: true },
});
