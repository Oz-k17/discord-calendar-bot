import { defineConfig } from 'vite';
import { classicScript, singleFileOutput } from '../../vite-shared';

/**
 * 書き出しの費用を測る試作の設定。
 *
 * **この試作には画面が無い**（`index.html` は説明だけ）。それでも vite を置いてあるのは、
 * 実測がブラウザの中でしか成り立たないため——エンコーダもデコーダも WebCodecs なので、
 * Node 側には測る相手が無い。`bench.mjs` がここを立ち上げて、空のページへ
 * `testkit/measure.ts` を差し込んで回す（`scene-cut/uitest.mjs` と同じ形）。
 *
 * `server.fs.allow` を広げているのは、測る部品が root の外を 2 つ借りているため——
 * 素材（`lab/fixtures/`）と、焼く部品（`scene-cut/testkit/encode.ts`）。
 * **焼き方を書き写さない**ことで、素材の粒がほかの試作とそろう。
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
