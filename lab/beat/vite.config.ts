import { defineConfig } from 'vite';
import { classicScript, singleFileOutput } from '../../vite-shared';

/**
 * 拍の画面のビルド設定。`auto-cut` のものと同じ理由で同じ形にしてある
 * （置き場所は `docs/lab/` だったり、リポジトリを落として直接開いたりするので、
 *  file:// で開いても動く 1 ファイルにまとめる）。
 *
 * 違うのは `server.fs.allow` の 1 行だけ。この画面は
 * `auto-cut/src/peaks.ts`（波形の山と谷）と、同じ所の `style.css` を借りていて、
 * どちらも vite の root（`lab/beat`）の外にある。開発サーバは既定だと
 * root の外を配らないので、リポジトリの根を許しておく。
 * **借りているのは「判断しない部品」だけ**で、判定は `beat/src/` の中で閉じている。
 */
export default defineConfig({
  plugins: [classicScript()],
  base: './',
  server: { fs: { allow: ['../..'] } },
  build: {
    modulePreload: false,
    rollupOptions: { output: singleFileOutput },
  },
});
