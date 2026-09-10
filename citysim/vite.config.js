import { defineConfig } from 'vite';

// `base` only applies to the production build: GitHub Pages serves this from
// https://rebollo507.github.io/Metropolis/, so built asset URLs need that prefix.
// The dev server stays at the root, where it is easier to work with.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/Metropolis/' : '/',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { target: 'esnext', sourcemap: false },
  optimizeDeps: { include: ['three'] },
}));
