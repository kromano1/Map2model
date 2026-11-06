import { defineConfig } from 'vite';

// Relative base so the build can be hosted from any sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
});
