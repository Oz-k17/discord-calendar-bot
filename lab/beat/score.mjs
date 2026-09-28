/**
 * 出した拍を、正解と突き合わせて点にする。
 *
 * **`bench.mjs`（コマンドライン）と `uitest.mjs`（画面）の両方がここを見る。**
 * 画面の確認は「コマンドラインと同じ数字が出るか」を見るためのものなので、
 * 物差しを 2 か所に書くと**その食い違いだけが見えなくなる**（画面の配線が
 * 切れていても、物差しのほうがずれていても、同じ「数字が違う」に見えてしまう）。
 */

/** 正解と突き合わせる許容幅（秒）。音楽の研究でよく使われる ±70ms。 */
export const TOLERANCE = 0.07;

/**
 * 正解の拍と突き合わせる。1 つの正解には 1 本だけ当てる
 * （同じ所に 2 本出して 2 点取る、を防ぐ）。
 */
export function scoreBeats(got, truth, tolerance = TOLERANCE) {
  if (truth.length === 0) {
    // 拍の無い素材では「何も出さない」が満点。出した本数がそのまま空振り。
    return { f: got.length === 0 ? 1 : 0, hit: 0, precision: null, recall: null, offset: null };
  }
  const taken = new Set();
  const gaps = [];
  let hit = 0;
  for (const b of got) {
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < truth.length; i += 1) {
      if (taken.has(i)) continue;
      const gap = Math.abs(truth[i] - b);
      if (gap <= tolerance && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (best >= 0) {
      taken.add(best);
      hit += 1;
      gaps.push(bestGap);
    }
  }
  const precision = got.length > 0 ? hit / got.length : 0;
  const recall = hit / truth.length;
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    f,
    hit,
    precision,
    recall,
    offset: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
  };
}
