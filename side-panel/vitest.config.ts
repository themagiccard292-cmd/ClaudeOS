import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          globals: true,
          include: ['src/renderer/**/*.test.{ts,tsx}', 'src/shared/**/*.test.ts'],
          setupFiles: [resolve(import.meta.dirname, 'src/renderer/test/setup.ts')],
        },
      },
      {
        test: {
          name: 'main',
          environment: 'node',
          globals: true,
          include: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts', 'test/**/*.test.ts'],
          testTimeout: 20000,
        },
      },
    ],
  },
});
