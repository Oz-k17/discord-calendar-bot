/**
 * 枠の置き所を採点する物差し。
 *
 * **`bench.mjs` と `uitest.mjs` が同じ関数を呼ぶために切り出してある**
 * （`scene-cut/score.mjs` と同じ立場）。画面の確認でいちばん見たいのは
 * 「画面が出した枠が、コマンドラインの枠と同じか」なので、
 * **採点する側が 2 つあると、食い違いが判定の違いなのか採点の違いなのか読めない。**
 *
 * 入口はどれも「枠の中心の列（`centers`）と時刻の列（`times`）」だけを取る。
 * 計画（`ReframePlan`）を取らないのは、比べる相手（ずっと真ん中）や
 * 画面から読み出した列も、同じ物差しに載せたいため。
 */

import { leadSubjectAt } from '../fixtures/scenes.mjs';

export const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * 被写体を枠に入れられているか。
 *
 * **「入れた」は被写体の中心が窓に入っていること。** 被写体（横幅 40%）は
 * 窓（31.6%）より広いので、どこに置いても全身は入らない——だから中心で数える。
 * 画面の外に居るコマは追いようが無いので数えない。
 */
export function scoreFollow(fixture, times, centers, cropWidth, aspect = 'landscape') {
  const half = cropWidth / 2;
  const errors = [];
  let inside = 0;
  let counted = 0;
  for (let i = 0; i < centers.length; i += 1) {
    const truth = leadSubjectAt(fixture, times[i], aspect);
    if (!truth) continue;
    if (truth.u < 0 || truth.u > 1) continue;
    counted += 1;
    const err = Math.abs(truth.u - centers[i]);
    errors.push(err);
    if (err < half) inside += 1;
  }
  return { inside: counted ? (inside / counted) * 100 : null, error: median(errors), counted };
}

/**
 * 枠が動いたひと続き（run）を、始まった時刻つきで取り出す。
 *
 * コマ単位ではなく run 単位で持つのは、**カット直後の組み直しを丸ごと外す**ため
 * （下の `scoreSwim` の注を参照）。
 */
export function movingRuns(times, centers) {
  const runs = [];
  let open = null;
  for (let i = 1; i < centers.length; i += 1) {
    const moved = Math.abs(centers[i] - centers[i - 1]);
    if (moved > 0) {
      if (!open) open = { start: times[i - 1], travel: 0 };
      open.travel += moved;
    } else if (open) {
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);
  return runs;
}

/**
 * **カットの直後に枠を置き直すのは正しい振る舞い**なので、泳ぎから外す。
 *
 * 場面が変われば構図も変わるから、そこで枠が動くのは「泳いだ」ではなく「組み直した」。
 * 外さずに数えると、カットの多い素材ほど悪く見えて、**直すべきでない所を直しにいく**。
 *
 * ただし「カットから 0.6 秒のあいだのコマを外す」では足りない（2026-09-24・3 回目に測った）。
 * 寄せの上限は 0.22/s なので端から端まで組み直すのに 3 秒以上かかり、
 * コマで外すと組み直しの大半が窓の外に落ちる。なので外すのは**ひと続きごと**で、
 * **その始まりがカットから 0.6 秒以内なら、その run は丸ごと組み直し**とみなす。
 */
export const AFTER_CUT = 0.6;

export function scoreSwim(times, centers, cuts, fps) {
  const seconds = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const runs = movingRuns(times, centers);
  const isRecompose = (r) => cuts.some((c) => r.start >= c - 1 / fps && r.start < c + AFTER_CUT);
  const wander = runs.filter((r) => !isRecompose(r));
  const sum = (rs) => rs.reduce((a, r) => a + r.travel, 0);
  return {
    swim: seconds > 0 ? sum(wander) / seconds : 0,
    wanders: wander.length,
    recompose: seconds > 0 ? sum(runs.filter(isRecompose)) / seconds : 0,
    range: centers.length ? Math.max(...centers) - Math.min(...centers) : 0,
  };
}

/** カットを分けずに数えた泳ぎ（被写体の**居る**素材の表で使う。組み直しも動きのうち）。 */
export function totalSwim(times, centers) {
  const seconds = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  let travel = 0;
  for (let i = 1; i < centers.length; i += 1) travel += Math.abs(centers[i] - centers[i - 1]);
  return seconds > 0 ? travel / seconds : 0;
}
