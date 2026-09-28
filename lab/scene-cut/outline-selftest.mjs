/**
 * **素材の側**の検算（字の縁取り・2026-09-24・2 回目）。
 *
 * `src/selftest.ts` は素材を作らない（7MB のコマの列を毎回作らないため）ので、
 * 帯の描き方を黙って無視する実装を入れても 1 件も落ちない。
 * 9/24（1 回目）に板の透け方でそれを実際に踏んだので、縁取りも同じように
 * **絵を描いてみる検算**を持たせる。`selftest.mjs` から呼ばれる。
 *
 * ここで守りたいのは 4 つ:
 *   1. 縁取りは**字を太らせない**（板の側だけを食う）
 *   2. 縁取りの面積は**太さに比例する**（＝太さとして扱えている）
 *   3. **点で引くと面積として残らない**（現実の太さは 1 画素より細いので、当たり外れになる）
 *   4. 縁取りは**字と一緒に動く**（動かない見出しでは 1 ビットも動かない）
 *
 * 速さのために、素材は 2fps まで落とした 1 本だけを描く。
 */

import { renderSpec } from '../fixtures/make-frames.mjs';

/** 検算用の 1 本。帯を厚めに取ってあるのは、字の高さが画素で数えられるようにするため。 */
const BAND = { top: 0.2, bottom: 0.2, changeEvery: 1.5 };

function draw(options, render = {}, band = BAND) {
  return renderSpec(
    { name: 'outline-check', cuts: [], options: { seed: 7, captions: { ...band, ...options } } },
    { fps: 2, ...render },
  );
}

/** 字（明るい所）の画素を数える。 */
function inkPixels(frame) {
  let n = 0;
  for (let p = 0; p < frame.data.length; p += 4) if (frame.data[p] > 128) n += 1;
  return n;
}

/**
 * 縁取りが覆っている面積（画素いくつぶん）。
 *
 * **黒い画素の数では数えない。** 部分的に覆っている画素が数に入らないので、
 * 現実の太さ（0.27 画素）では 0 になってしまう。縁取りの無い同じコマからの寄りを
 * 板（22）と黒（0）の差で割ると、部分被覆も足し合わさった面積になる。
 */
function outlineArea(options, render = {}, index = 1, rows = null) {
  const a = draw({ ...options, outline: 0 }, render);
  const b = draw(options, render);
  const off = a.frames[index].data;
  const on = b.frames[index].data;
  const from = rows ? rows.from : 0;
  const to = rows ? rows.to : a.height;
  let sum = 0;
  for (let y = from; y < to; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const p = (y * a.width + x) * 4;
      sum += off[p] - on[p];
    }
  }
  return sum / 22;
}

export async function runOutlineFixtureTests() {
  const results = [];
  const W = 0.0037; // 1080p の 4 画素ぶん（現実の太さ）
  const S = 8; // 面積で混ぜるときの分割数。収束の確認は下で別に取る

  // 1. 字を太らせない ------------------------------------------------------
  //
  // 縁取りを「字の外側」ではなく「字の縁」に描く実装（＝字を細らせる／太らせる）でも
  // 面積の検算は通ってしまうので、**字の画素が 1 つも動かないこと**を別に見る。
  {
    const bare = inkPixels(draw({ samples: S }).frames[1]);
    const lined = inkPixels(draw({ outline: W * 4, samples: S }).frames[1]);
    results.push({
      name: '縁取りは字を太らせない（字の画素は 1 つも動かない）',
      ok: bare > 0 && bare === lined,
      detail: `字の画素 縁なし ${bare} / 縁あり ${lined}`,
    });
  }

  // 2. 太さに比例する ------------------------------------------------------
  //
  // 輪郭の長さ × 太さ なので、太さを 2 倍にすれば面積も 2 倍に近づく。
  // **比例しないなら、それは太さではなく「有無」を描いている。**
  {
    const a = outlineArea({ outline: W, samples: S });
    const b = outlineArea({ outline: W * 2, samples: S });
    const ratio = b / a;
    results.push({
      name: '縁取りの面積は太さに比例する（太さ 2 倍で面積 2 倍）',
      ok: a > 1 && ratio > 1.7 && ratio < 2.3,
      detail: `${a.toFixed(1)}px → ${b.toFixed(1)}px（${ratio.toFixed(2)} 倍）`,
    });
  }

  // 3. 点で引くと「太さ」ではなくなる --------------------------------------
  //
  // これは実装の正しさではなく**この素材の性質**の検算で、
  // 面積で混ぜる道を足した理由そのもの。現実の太さは 1 画素より細いので、
  // 画素の中心で引くと**当たり外れ**になる——太さを 2 倍にしても面積は 2 倍にならない。
  //
  // 面積そのものを分割 1 と比べないのは、**当たり外れなので近い数が出ることもある**から
  // （実際この帯では 85px 対 100px で 15% しか違わない）。
  // 壊れているのは値ではなく**比例**のほうなので、そこを見る。
  {
    const point = outlineArea({ outline: W, samples: 1 });
    const pointTwice = outlineArea({ outline: W * 2, samples: 1 });
    const ratio = pointTwice / point;
    results.push({
      name: '点で引くと、太さを 2 倍にしても面積が 2 倍にならない（だから面積で混ぜる）',
      ok: point > 0 && (ratio < 1.7 || ratio > 2.3),
      detail: `分割 1 で ${point.toFixed(1)}px → ${pointTwice.toFixed(1)}px（${ratio.toFixed(2)} 倍）`,
    });
  }

  // 4. 字と一緒に動く ------------------------------------------------------
  //
  // 板と縁取りの違いはここだけなので、**動くことと動かないことを両方**見る。
  // 下の帯（字幕）は 1.5 秒ごとに書き換わるので縁の面積が変わり、
  // 上の帯（見出し）は書き換わらないので 1 画素も動かない。
  //
  // 数えるのは**縁の面積**であって帯の明るさではない。明るさで数えると
  // 「字が書き換わったこと」そのものを測ってしまい、**縁取りを黙って無視する実装でも通る**
  // （実際にそれで 1 度通した）。
  {
    const clip = draw({ outline: W, samples: S });
    const height = clip.height;
    const opts = { outline: W, samples: S };
    // 2fps なので 1.5 秒の書き換えは 3 コマ目と 4 コマ目のあいだに入る。
    const top = { from: 0, to: Math.floor(0.2 * height) };
    const bottom = { from: Math.ceil(0.8 * height), to: height };
    const topMoved = outlineArea(opts, {}, 3, top) - outlineArea(opts, {}, 2, top);
    const bottomMoved = outlineArea(opts, {}, 3, bottom) - outlineArea(opts, {}, 2, bottom);
    const bottomArea = outlineArea(opts, {}, 2, bottom);
    results.push({
      name: '縁取りは字と一緒に動く（字幕では面積が変わり、動かない見出しでは 1 画素も動かない）',
      ok: bottomArea > 1 && Math.abs(topMoved) < 1e-9 && Math.abs(bottomMoved) > 1,
      detail: `縁の面積 見出しの動き ${topMoved.toFixed(2)}px / 字幕 ${bottomArea.toFixed(1)}px が ${bottomMoved.toFixed(1)}px 動く`,
    });
  }

  // 4b. 縁取りは字に隣り合っていて、太さが縦横で同じ --------------------------
  //
  // 4 の「面積が動く」だけでは、**字とは関係のない所に描かれた縁取り**が通ってしまう
  // （升目の並びを固定した実装で実際に通った。字が動けばその下の縁が隠れるので、
  // 面積のほうは動いてしまう）。縁取りの定義は「字の周り」なので、そこを直接見る。
  //
  // ここだけ**点で引いた太い縁取り**（0.03 ＝ 2.2 画素）で測る。面積で混ぜた薄い縁は
  // 中間色になるので「縁の画素」を色で拾えない。太さの話なので、太くても筋は同じ。
  {
    const thick = 0.03;
    const clip = draw({ outline: thick, samples: 1 });
    const { width, height, data } = { ...clip, ...clip.frames[1] };
    const at = (x, y) => (y * width + x) * 4;
    const isInk = (x, y) => data[at(x, y)] > 128;
    const isStroke = (x, y) => data[at(x, y)] < 8 && data[at(x, y) + 1] < 8 && data[at(x, y) + 2] < 10;

    // (1) 縁の画素は、縦横それぞれ「太さ＋1 画素」のうちに字がある。
    const reachV = Math.ceil(thick * height) + 1;
    const reachU = Math.ceil(((thick * height) / width) * width) + 1;
    let strokes = 0;
    let orphans = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!isStroke(x, y)) continue;
        strokes += 1;
        let found = false;
        for (let j = -reachV; j <= reachV && !found; j += 1) {
          for (let i = -reachU; i <= reachU && !found; i += 1) {
            const yy = y + j;
            const xx = x + i;
            if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
            if (isInk(xx, yy)) found = true;
          }
        }
        if (!found) orphans += 1;
      }
    }
    results.push({
      name: '縁の画素はすべて字の近くにある（字と関係の無い所に縁は出ない）',
      ok: strokes > 20 && orphans === 0,
      detail: `縁の画素 ${strokes} / 字から離れていたもの ${orphans}`,
    });

    // (2) 太さは縦と横で同じ（画素は正方形なので、同じ「高さの割合」から同じ画素数が出る）。
    //     縦横比を掛け忘れた実装は、横だけ 16/9 倍太くなる。
    const runs = (pick) => {
      const found = [];
      for (const [a, b] of pick) {
        let n = 0;
        let step = 0;
        while (step < 8) {
          const p = b(a, step);
          if (!p || !isStroke(p[0], p[1])) break;
          n += 1;
          step += 1;
        }
        if (n > 0) found.push(n);
      }
      found.sort((p, q) => p - q);
      return found.length ? found[Math.floor(found.length / 2)] : 0;
    };
    // 字のいちばん上の行を探して、そのすぐ上へ何画素ぶん縁が続くかを数える（縦）。
    const tops = [];
    const lefts = [];
    for (let x = 1; x < width - 1; x += 1) {
      for (let y = 1; y < height - 1; y += 1) {
        if (isInk(x, y) && !isInk(x, y - 1)) {
          tops.push([[x, y], (a, s) => [a[0], a[1] - 1 - s]]);
          break;
        }
      }
    }
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        if (isInk(x, y) && !isInk(x - 1, y)) {
          lefts.push([[x, y], (a, s) => [a[0] - 1 - s, a[1]]]);
          break;
        }
      }
    }
    const vertical = runs(tops);
    const horizontal = runs(lefts);
    results.push({
      name: '縁取りの太さは縦と横で同じ（高さの割合として置いてある）',
      ok: vertical > 0 && Math.abs(vertical - horizontal) <= 1,
      detail: `縦 ${vertical} 画素 / 横 ${horizontal} 画素（設計値 ${(thick * height).toFixed(1)}）`,
    });
  }

  // 5. 混ぜ方を変えただけでは、測る数字が動かない ----------------------------
  //
  // 縁取りを足すときに描き方（面積で混ぜる）も一緒に変えているので、
  // **混ぜ方だけで数字が動いていないこと**を押さえておかないと、
  // 「縁取りが効いた」と「混ぜ方を変えたから動いた」を分けられない。
  //
  // **絵の画素で比べるのでは足りない。** 面積で混ぜると帯の縁も字の縁も滑らかになるので、
  // 画素の寄りは画素あたり 3 くらい出る（帯の 16% が動く）。それでも分布の距離は動かない
  // ——**動いた画素の数ではなく升目の出入りを数えている**から。見たいのは後者なので後者で見る。
  //
  // ただし**帯の外の縁が画素の境に乗っていないと、そこだけは動く**（下の 6 で測る）。
  // ここで帯の厚みを画素の境に合わせてあるのはそのため。
  const { DISTANCES, summarizeFrames } = await import('./src/frames.ts');
  const peak = (band, options, render = {}) => {
    const clip = draw({ ...options }, render, band);
    const stats = summarizeFrames(clip.frames, clip.times);
    let max = 0;
    for (let i = 1; i < stats.length; i += 1) max = Math.max(max, DISTANCES.combined(stats[i - 1], stats[i]));
    return max;
  };
  /** 帯の外の縁が画素の境にぴったり乗る厚み（72 画素の 4 行と 8 行）。 */
  const ALIGNED = { top: 4 / 72, bottom: 8 / 72, changeEvery: 1.5 };
  {
    const point = peak(ALIGNED, { samples: 1 });
    const area = peak(ALIGNED, { samples: S });
    results.push({
      name: '混ぜ方を面積へ変えただけでは、書き換えの山が動かない（縁取りの効きと混ざらない）',
      ok: point > 0 && Math.abs(area - point) / point < 0.05,
      detail: `書き換えの山 点で ${point.toFixed(4)} / 面積で ${area.toFixed(4)}（${((area / point - 1) * 100).toFixed(1)}%）`,
    });
  }

  // 6. 帯の外の縁が画素の境から外れていると、そこだけは「生きた」線になる ---------
  //
  // これは不具合ではなく**面積で混ぜることの性質**。帯の外の縁が画素を半分だけ覆うと、
  // その 1 行は「板 半分＋下の絵 半分」になるので、**下の絵と一緒に動く**。
  // 帯が動かない前提（9/22・3 回目からの薄まりの読み）はその 1 行では成り立たない。
  //
  // 数を固定せず**向きだけ**を見ているのは、動く量が「縁の下で何が動いているか」で決まり、
  // 素材の種を変えれば変わるため。固定すると素材を足すたびに落ちる検算になる。
  {
    const off = { top: 0.2, bottom: 0.2, changeEvery: 1.5 };
    const point = peak(off, { samples: 1 });
    const area = peak(off, { samples: S });
    results.push({
      name: '帯の外の縁が画素の境から外れていると、面積で混ぜたぶんだけ下の絵が透ける',
      ok: point > 0 && (area - point) / point > 0.15,
      detail: `書き換えの山 点で ${point.toFixed(4)} / 面積で ${area.toFixed(4)}（${((area / point - 1) * 100).toFixed(1)}%）`,
    });
  }

  return results;
}
