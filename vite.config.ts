import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { classicScript, singleFileOutput } from './vite-shared';

export default defineConfig({
  plugins: [react(), classicScript()],
  // どこに置いても動くよう、参照は相対パスにする。
  base: './',
  build: {
    modulePreload: false,
    rollupOptions: { output: singleFileOutput },
  },
  server: {
    port: 5173,
    host: true,
  },
});
