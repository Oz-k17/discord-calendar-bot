import { defineConfig } from 'vite';
import { classicScript, singleFileOutput } from '../../vite-shared';

/**
 * 表紙の画面のビルド設定。`auto-cut` / `beat` / `scene-cut` と同じ理由で同じ形にしてある
 * （置き場所は `docs/lab/` だったり、リポジトリを落として直接開いたりするので、
 *  file:// で開いても動く 1 ファイルにまとめる）。
 *
 * `server.fs.allow` を広げているのは 3 つ目と同じ事情で、この画面は
 * `scene-cut/src/decode.ts`（動画を読む）・`scene-cut/src/frames.ts`（分布の要約）と、
 * `auto-cut/src/style.css` を借りていて、どれも vite の root（`lab/thumbnail`）の外にある。
 * 確かめ用の `testkit/` は素材（`lab/fixtures/`）も読むので、そちらも同じ範囲に入る。
 * **借りているのは「判断しない部品」だけ**で、表紙の判定は `thumbnail/src/` の中で閉じている。
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
