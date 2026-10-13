import { defineConfig } from 'vitest/config';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  base: './',
  plugins: [cesium()],
  build: { chunkSizeWarningLimit: 6000 },
  test: { include: ['tests/**/*.test.ts'] },
});
