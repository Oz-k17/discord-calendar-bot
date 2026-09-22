import { defineConfig } from 'vite';
import { classicScript, singleFileOutput } from '../../vite-shared';

/**
 * シーン検出の画面のビルド設定。`auto-cut` / `beat` と同じ理由で同じ形にしてある
 * （置き場所は `docs/lab/` だったり、リポジトリを落として直接開いたりするので、
 *  file:// で開いても動く 1 ファイルにまとめる）。
 *
 * `server.fs.allow` を広げているのは拍の画面と同じ事情で、この画面は
 * `auto-cut/src/style.css` を借りていて、それが vite の root（`lab/scene-cut`）の外にあるため。
 * 確かめ用の `testkit/` は素材（`lab/fixtures/`）も読むので、そちらも同じ範囲に入る。
 * **借りているのは「判断しない部品」だけ**で、判定は `scene-cut/src/` の中で閉じている。
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
