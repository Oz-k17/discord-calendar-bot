/**
 * 試し素材を**本物の動画ファイルに焼く**口。中身はシーン検出の testkit と同じもの。
 *
 * ## これは画面の一部ではない
 *
 * `index.html` からは読み込んでいない。`uitest.mjs` が playwright 越しに差し込むためだけに置いてある。
 *
 * ## 焼く部品を書き直していない理由
 *
 * `scene-cut/testkit/encode.ts` は**素材の一覧に依らない**（`renderFixture` に名前を渡すだけ）。
 * リフレームの素材（`REFRAME_FIXTURES`）も同じ `renderFixture` から出てくるので、
 * そのまま通る。2 本持つと、焼き方を変えたときに片方だけ古くなる。
 *
 * 別名（`__labReframeEncode`）にしてあるのは、**どちらの画面を確かめているかを
 * 取り違えないため**だけで、指しているものは同じ関数。
 *
 * `tsconfig.json` の `include` に入れていないのも `scene-cut` と揃えてある
 * （素材を作る側が `.mjs` で型を持たないので、型検査へ入れると
 *  そこだけ `any` を許す設定が要る。確かめ用の部品のために本体側を緩めない）。
 */

import { encodeFixture } from '../../scene-cut/testkit/encode.ts';

declare global {
  interface Window {
    __labReframeEncode: typeof encodeFixture;
  }
}
window.__labReframeEncode = encodeFixture;
