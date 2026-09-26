/**
 * 表紙の試し素材（`lab/fixtures/thumbs.mjs`）を、**本物の動画ファイルに焼く**。
 *
 * ## これは画面の一部ではない
 *
 * `index.html` からは読み込んでいない。`uitest.mjs` が playwright 越しに
 * `<script type="module">` として差し込むためだけに置いてある
 * （シーン検出の `testkit/` と同じ立場・同じ理由）。
 *
 * ## なぜ焼く所を別に持つのか
 *
 * 焼く手順そのものは `scene-cut/testkit/encode.ts` の `encodeClip` を借りている。
 * 分けてあるのは**素材の引き方だけ**で、表紙の素材は `scenes.mjs` ではなく
 * `thumbs.mjs` に居る（振り切ってから止まるカメラ・粒・帯は、あちらには無い）。
 *
 * ## なぜ 4 倍に拡大して焼くのか
 *
 * 素材は 128×72 で描いてある。ところが画面は**測るときに長辺 128 へ縮める**ので、
 * 等倍で焼くと「縮める前」と「縮めた後」が同じ大きさになり、
 * **書き出しが素材の大きさで出ているのか、測ったコマを出しているのかが区別できない。**
 * 4 倍（512×288）で焼けば、測るコマは 128×72・書き出すコマは 512×288 と分かれる。
 * 引き伸ばすだけなので、どの秒に何が写っているかは 1 つも動かない。
 */

import { encodeClip, type EncodedFixture, type RenderedClip } from '../../scene-cut/testkit/encode.ts';
import { renderSpec } from '../../fixtures/make-frames.mjs';
import { thumbFixture } from '../../fixtures/thumbs.mjs';

/** 焼くときの拡大率。上の注のとおり、「測るコマ」と「書き出すコマ」を分けるために要る。 */
export const ENCODE_SCALE = 4;

export interface EncodedThumbFixture extends EncodedFixture {
  /** 正解の区間（そのまま採点に使う）。 */
  bad: { from: number; to: number; why?: string }[];
  good: { from: number; to: number }[];
  shots: number[] | null;
}

export async function encodeThumbFixture(
  name: string,
  {
    aspect = 'landscape',
    scale = ENCODE_SCALE,
    // 帯の板の不透明度（2026-09-24）。既定は null ＝ 素材の書いたまま（不透明）。
    // **書き出しの誤差を帯の中と外で比べる話は、板が平らな板かどうかで答えが変わる**ので、
    // ここを外から差し替えられないと、9/23（3 回目）の結論が不透明な帯でしか確かめられない。
    captionAlpha = null,
  }: { aspect?: string; scale?: number; captionAlpha?: number | null } = {},
): Promise<EncodedThumbFixture> {
  const spec = thumbFixture(name);
  const clip = renderSpec(spec, { aspect, captionAlpha }) as RenderedClip;
  const encoded = await encodeClip(clip, { scale });
  return { ...encoded, bad: spec.bad, good: spec.good, shots: spec.shots };
}

declare global {
  interface Window {
    __labThumbEncode: typeof encodeThumbFixture;
  }
}
window.__labThumbEncode = encodeThumbFixture;

/**
 * 書き出した絵と、**測るのに使ったコマ**が同じ絵かを確かめる。
 *
 * ここを確かめないと、この画面のいちばん静かな壊れ方——
 * **選んだ秒と書き出す秒が 1 コマずれる**——が誰にも見えない。
 * 絵は出るし、大きさも合っているし、点も出る。違うのは「写っているもの」だけで、
 * それは数字のどこにも出ない。
 *
 * 突き合わせ方は、書き出した PNG を**測るときと同じ大きさへ縮めてから**
 * 分布の隔たり（`combinedHistDistance`）を取る。ぴったり 0 にはならない
 * （書き出しは素材の大きさから、測るコマは長辺 128 から、それぞれ別に縮めている）。
 * 見たいのは 0 かどうかではなく、**別のコマと比べたときに桁が違うか**。
 */
export async function compareExport(
  order: number,
  options: { format?: 'png' | 'jpeg'; quality?: number } = {},
): Promise<{ self: number; others: number[]; type: string; bytes: number }> {
  const { combinedHistDistance, summarizeFrames } = await import('../../scene-cut/src/frames.ts');

  const mine = window.__labThumb.analysisFrame(order);
  if (!mine) throw new Error(`候補 ${order} はありません`);

  // 形式を渡せるようにしてある。**非可逆でも同じ絵が出ることを確かめたい**ので、
  // PNG の道だけを見ていたのでは足りない（JPEG は別の `toBlob` を通る）。
  const blob = await window.__labThumb.image(order, options);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = mine.width;
  canvas.height = mine.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  ctx.drawImage(bitmap, 0, 0, mine.width, mine.height);
  const shrunk = ctx.getImageData(0, 0, mine.width, mine.height);

  const count = window.__labThumb.state().picks.length;
  const others: number[] = [];
  const frames = [{ width: shrunk.width, height: shrunk.height, data: shrunk.data }, mine];
  for (let i = 0; i < count; i += 1) {
    if (i === order) continue;
    const other = window.__labThumb.analysisFrame(i);
    if (other) frames.push(other);
  }
  const stats = summarizeFrames(frames, frames.map((_, i) => i));
  for (let i = 2; i < stats.length; i += 1) others.push(combinedHistDistance(stats[0], stats[i]));
  return { self: combinedHistDistance(stats[0], stats[1]), others, type: blob.type, bytes: blob.size };
}

declare global {
  interface Window {
    __labThumbCompare: typeof compareExport;
  }
}
window.__labThumbCompare = compareExport;
