import { defineConfig } from 'vite';
import { classicScript, singleFileOutput } from '../../vite-shared';

/**
 * 自動リフレームの画面のビルド設定。`auto-cut` / `beat` / `scene-cut` / `thumbnail` と
 * 同じ理由で同じ形にしてある（置き場所は `docs/lab/` だったり、リポジトリを落として
 * 直接開いたりするので、file:// で開いても動く 1 ファイルにまとめる）。
 *
 * `server.fs.allow` を広げているのは、この画面が root（`lab/reframe`）の外にある
 * **判断しない部品**を 2 つ借りているため——見た目（`auto-cut/src/style.css`）と
 * 読み込み（`scene-cut/src/decode.ts`）。確かめ用の `testkit/` は素材（`lab/fixtures/`）も読む。
 * **借りているのは判断を置かない部品だけ**で、判定は `reframe/src/` の中で閉じている。
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
