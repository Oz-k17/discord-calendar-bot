import { defineConfig } from 'vite';
import { classicScript, singleFileOutput } from '../../vite-shared';

/**
 * ラボの画面のビルド設定。
 *
 * `npm run lab` で触るときは使われないが、`docs/lab/` へ配るときに効く。
 * 本体と同じく「どこに置いても、file:// で開いても動く」形にしておく
 * （置き場所は docs/lab/ だったり、リポジトリを落として直接開いたりする）。
 */
export default defineConfig({
  plugins: [classicScript()],
  base: './',
  build: {
    modulePreload: false,
    rollupOptions: { output: singleFileOutput },
  },
});
