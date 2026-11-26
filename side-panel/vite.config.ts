import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Renderer build: src/renderer -> dist/renderer (loaded via file:// by Electron, hence base './').
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome140',
  },
  server: { port: 5173, strictPort: false },
});
