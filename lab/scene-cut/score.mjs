/**
 * 見つけた切り所を、正解と突き合わせて採点する。
 *
 * `bench.mjs`（コマンドライン）と `uitest.mjs`（画面）の**両方がここを呼ぶ**。
 * 拍の側の `beat/score.mjs` と同じ立場で、分けてあるのは
 * 「画面とコマンドラインを突き合わせる」ときに**同じ物差しであることが前提**になるため。
 * 片方に写して直すと、食い違ったときに「判定がずれた」のか
 * 「数え方がずれた」のかが分からなくなる。
 */

/**
 * 正解と突き合わせる許容幅（秒）。
 *
 * 瞬間のカットは 0.2 秒（15fps でコマ 3 枚ぶん）。
 * **ディゾルブだけ広げてある**（1 秒かけて渡るので ±0.5 秒）。
 * 渡りの真ん中を正解に置いた以上、渡りの中のどこで切っても「当たり」と数えるのが筋で、
 * そこを 0.2 秒のままにすると「正しく渡りを見つけたのに外れ」と数えることになる。
 * フェードは正解を黒の両端に置き直したので、広げる必要が無くなった。
 */
export const TOLERANCE = { dissolve: 0.5 };
export const DEFAULT_TOLERANCE = 0.2;

/** 素材の名前から許容幅を引く。 */
export function toleranceFor(name) {
  return TOLERANCE[name] ?? DEFAULT_TOLERANCE;
}

/**
 * 見つけた秒の列と正解の秒の列を突き合わせる。
 *
 * **正解 1 本に当てられるのは 1 本まで。** 近い所へ 2 本立てたときに
 * 両方を当たりと数えると、「1 つの切り所を 2 回見つけた」が得点になってしまう。
 * 近いほうから順に取っていく形にしてある。
 */
export function scoreBoundaries(found, truth, tolerance = DEFAULT_TOLERANCE) {
  const taken = new Set();
  const offsets = [];
  let hit = 0;
  for (const time of found) {
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < truth.length; i += 1) {
      if (taken.has(i)) continue;
      const gap = Math.abs(truth[i] - time);
      if (gap <= tolerance && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (best >= 0) {
      taken.add(best);
      hit += 1;
      offsets.push(bestGap);
    }
  }
  return {
    hit,
    missed: truth.length - hit,
    spurious: found.length - hit,
    offsets,
    meanOffset: offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : null,
  };
}
