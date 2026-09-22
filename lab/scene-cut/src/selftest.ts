/**
 * 合成したコマで、計算そのものが正しいかを確かめる。
 *
 * 素材（`make-frames.mjs`）は使わない。あちらは 1 本 7MB を毎回その場で作るので、
 * **手を入れるたびに走らせるもの**の中に置くと重すぎる。
 * ここで見るのは「計算が合っているか」だけで、効きは `npm run lab:scene` が見る。
 */

import {
  combinedHistDistance,
  DISTANCES,
  GRID_H,
  GRID_W,
  gridDistance,
  lumaHistDistance,
  rgbHistDistance,
  summarizeFrame,
  summarizeFrames,
  type FrameLike,
  type FrameStat,
} from './frames.ts';
import {
  DEFAULT_SCENE_CUT,
  localRatioAt,
  planSceneCut,
  sceneDistances,
  straddleDistance,
  straddleSpan,
} from './scene.ts';
import { toClipEdits } from '../../auto-cut/src/edits.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const W = 64;
const H = 36;

/** 一様な色のコマ。 */
function solid(r: number, g: number, b: number, width = W, height = H): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/**
 * 縞模様のコマ。`shift` で横へ巻き戻しながらずらす（＝画面の外へ出たものが逆側から入る）。
 *
 * **巻き戻しにしてあるのが肝。** 端で切り落とす形でずらすと、明暗の面積の比そのものが
 * 変わるので、分布も素直に動いてしまう（ずらした割合ぶんちょうど動く）。
 * そこを「パンでは分布が動かない」の検算に使うと、**中身が入れ替わらない場合の話**しか
 * 確かめられない。現実のパンはその中間で、新しい中身が入ってくるぶんは分布も動く。
 */
function stripes(shift: number, width = W, height = H): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = (((x + shift) % width) + width) % width;
      const v = 30 + 200 * (0.5 + 0.5 * Math.sin((u / width) * 2 * Math.PI * 3));
      const p = (y * width + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** コマの列を秒に並べる。 */
function statsOf(frames: FrameLike[], fps = 15): FrameStat[] {
  return summarizeFrames(
    frames,
    frames.map((_, i) => i / fps),
  );
}

function approx(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance;
}

export function runSelfTest(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

  // --- frames.ts ---
  {
    const s = summarizeFrame(solid(255, 255, 255), 0);
    let sum = 0;
    for (const v of s.lumaHist) sum += v;
    let rgbSum = 0;
    for (const v of s.rgbHist) rgbSum += v;
    check(
      'ヒストグラムは合計 1 になる（画素数で割っている）',
      approx(sum, 1, 1e-9) && approx(rgbSum, 1, 1e-9),
      `明るさ ${sum.toFixed(6)} / 色 ${rgbSum.toFixed(6)}`,
    );
    check('真っ白の明るさは 1', approx(s.meanLuma, 1, 1e-6), s.meanLuma.toFixed(6));
    check('格子の大きさは画面の大きさに依らない', s.grid.length === GRID_W * GRID_H, `${GRID_W}×${GRID_H}`);
  }

  {
    // 縮小は「近い 1 点を拾う」ではなく升目の平均。半分だけ白い升目は 0.5 になるはず。
    // 升目の幅 = 64 / 32 = 2 画素なので、1 画素だけ白くすれば半分。
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i += 1) data[i * 4 + 3] = 255;
    for (let y = 0; y < H; y += 1) {
      const p = (y * W + 0) * 4;
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
    }
    const s = summarizeFrame({ width: W, height: H, data }, 0);
    check('縮小は升目の中を平均する（拾うのではなく）', approx(s.grid[0], 0.5, 1e-6), s.grid[0].toFixed(6));
  }

  {
    const s = summarizeFrame({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, 0);
    check('大きさ 0 のコマでも落ちない', s.grid.length === GRID_W * GRID_H && s.meanLuma === 0, '0 で返す');
  }

  {
    const a = summarizeFrame(solid(120, 60, 200), 0);
    const b = summarizeFrame(solid(120, 60, 200), 1);
    const all = Object.entries(DISTANCES).every(([, fn]) => fn(a, b) === 0);
    check('同じコマどうしの距離は、どの量でも 0', all, Object.keys(DISTANCES).join(' / '));
  }

  {
    const a = summarizeFrame(solid(0, 0, 0), 0);
    const b = summarizeFrame(solid(255, 255, 255), 1);
    check(
      '重なりの無い分布どうしは 1 で飽和する',
      approx(lumaHistDistance(a, b), 1, 1e-9) && approx(rgbHistDistance(a, b), 1, 1e-9),
      `明るさ ${lumaHistDistance(a, b).toFixed(3)} / 色 ${rgbHistDistance(a, b).toFixed(3)}`,
    );
  }

  {
    // 同じ模様を巻き戻しながら横へずらしただけ。分布は動かないが、画素の引き算は動く。
    const a = summarizeFrame(stripes(0), 0);
    const b = summarizeFrame(stripes(7), 1);
    check(
      '中身が入れ替わらないパンでは、明るさの分布は動かない（画素の引き算は動く）',
      lumaHistDistance(a, b) < 1e-9 && gridDistance(a, b) > 0.05,
      `分布 ${lumaHistDistance(a, b).toFixed(6)} 対 画素 ${gridDistance(a, b).toFixed(3)}`,
    );

    // 逆に、中身が入れ替われば分布も動く。**上の強さは素材の性質でもある**ことを固定しておく。
    const c = summarizeFrame(solid(40, 40, 40), 0);
    const d = summarizeFrame(
      (() => {
        const f = solid(40, 40, 40);
        for (let y = 0; y < H; y += 1)
          for (let x = 0; x < 8; x += 1) {
            const p = (y * W + x) * 4;
            f.data[p] = 230;
            f.data[p + 1] = 230;
            f.data[p + 2] = 230;
          }
        return f;
      })(),
      1,
    );
    check(
      '新しい中身が画面へ入ってくれば、分布もその面積ぶん動く',
      approx(lumaHistDistance(c, d), 8 / W, 1e-9),
      `${lumaHistDistance(c, d).toFixed(4)}（入ってきた面積 ${(8 / W).toFixed(4)}）`,
    );
  }

  {
    // 明るさを変えずに色だけを変える。`lumaHist` は原理的に 0 しか返せない。
    const a = summarizeFrame(solid(100, 100, 100), 0);
    const b = summarizeFrame(solid(30, 121, 61), 1);
    const luma = lumaHistDistance(a, b);
    const rgb = rgbHistDistance(a, b);
    check(
      '明るさが同じで色だけ違うと、明るさの分布は動かない',
      luma === 0 && rgb > 0.9,
      `明るさ ${luma.toFixed(3)} / 色 ${rgb.toFixed(3)}`,
    );
    check(
      '組み合わせた量は、大きいほうを取る（薄めない）',
      approx(combinedHistDistance(a, b), Math.max(luma, rgb)),
      combinedHistDistance(a, b).toFixed(3),
    );
  }

  // --- scene.ts: 素直なカット ---
  {
    const frames = [
      ...Array.from({ length: 15 }, () => solid(30, 30, 30)),
      ...Array.from({ length: 15 }, () => solid(220, 220, 220)),
    ];
    const plan = planSceneCut(statsOf(frames));
    check(
      '切り替わったコマを 1 本だけ見つける',
      plan.boundaries.length === 1 && approx(plan.boundaries[0].time, 1, 1e-9),
      `${plan.boundaries.length} 本 / ${plan.boundaries[0]?.time.toFixed(3)}s`,
    );
    check(
      '場面は隙間なく並び、合計が尺と一致する',
      plan.scenes.length === 2 &&
        approx(plan.scenes[0].end, plan.scenes[1].start) &&
        approx(plan.scenes[1].end - plan.scenes[0].start, 30 / 15),
      plan.scenes.map((s) => `${s.start.toFixed(2)}〜${s.end.toFixed(2)}`).join(' / '),
    );
  }

  {
    const frames = Array.from({ length: 30 }, () => solid(80, 90, 100));
    const plan = planSceneCut(statsOf(frames));
    check(
      '何も起きていない素材では、1 本も切らない（まるごと 1 場面）',
      plan.boundaries.length === 0 && plan.scenes.length === 1,
      `${plan.scenes.length} 場面`,
    );
  }

  {
    check('コマが 0 枚でも落ちない', planSceneCut([]).scenes.length === 0, '場面 0');
    const one = planSceneCut(statsOf([solid(10, 10, 10)]));
    check('コマが 1 枚でも落ちない', one.boundaries.length === 0 && one.scenes.length === 1, '場面 1');
  }

  // --- scene.ts: 戻ってくる変化を門で落とす ---
  {
    // 真ん中の 3 コマだけ白く飛ぶ（フラッシュ）。前後は同じ場面。
    const frames = Array.from({ length: 40 }, (_, i) =>
      i >= 19 && i <= 21 ? solid(255, 255, 255) : solid(60, 60, 60),
    );
    const stats = statsOf(frames);
    const gated = planSceneCut(stats);
    const open = planSceneCut(stats, { straddleThreshold: 0 });
    check(
      '戻ってくる変化（フラッシュ）は門が落とす',
      gated.boundaries.length === 0 && open.boundaries.length > 0,
      `門あり ${gated.boundaries.length} 本 / 門なし ${open.boundaries.length} 本`,
    );
    check(
      '落とした理由が残る',
      gated.rejected.some((r) => r.reason === 'straddle'),
      gated.rejected.map((r) => r.reason).join(','),
    );
  }

  {
    // またぐ幅より短い場面は、門が丸ごとまたいでしまう。**分かっている代価**なので固定しておく。
    const frames = Array.from({ length: 40 }, (_, i) =>
      i >= 20 && i <= 22 ? solid(230, 230, 230) : solid(60, 60, 60),
    );
    const plan = planSceneCut(statsOf(frames), { minScene: 0.1 });
    check(
      'またぐ幅より短い場面は、門が落とす（代価として固定）',
      plan.boundaries.length === 0 && plan.rejected.some((r) => r.reason === 'straddle'),
      `${plan.boundaries.length} 本`,
    );
    const narrow = planSceneCut(statsOf(frames), { minScene: 0.1, straddleFrames: 1 });
    check(
      'またぐ幅を縮めれば、その短い場面は拾える（釣り合いの相手はフラッシュ）',
      narrow.boundaries.length === 2,
      `${narrow.boundaries.length} 本`,
    );
  }

  {
    const stats = statsOf(Array.from({ length: 10 }, () => solid(50, 50, 50)));
    check(
      '端では、またげる幅が足りない（甘くなることを分かるようにしてある）',
      straddleSpan(stats, 0, 6) === 6 && straddleSpan(stats, 5, 6) === 9 && straddleSpan(stats, 5, 2) === 4,
      `頭 ${straddleSpan(stats, 0, 6)} / 中 ${straddleSpan(stats, 5, 6)} コマ`,
    );
    check('比べる相手がいなければ、またいだ距離は 0', straddleDistance(statsOf([solid(1, 1, 1)]), 0, 6, 'combined') === 0, '0');
  }

  // --- scene.ts: まとめ方 ---
  {
    // 渡りの途中に、弱い候補 → 強い候補 の順で山が 2 つ立つ形を作る。
    // 「先に来たものを残す」実装だと弱いほうが残ってしまう。
    const frames = [
      ...Array.from({ length: 10 }, () => solid(40, 40, 40)),
      solid(110, 110, 110),
      ...Array.from({ length: 10 }, () => solid(240, 240, 240)),
    ];
    const plan = planSceneCut(statsOf(frames), { minScene: 0.4, straddleFrames: 2 });
    const kept = plan.boundaries[0];
    const dropped = plan.rejected.filter((r) => r.reason === 'run' || r.reason === 'minScene');
    check(
      '近い候補が並んだら、いちばん大きく動いたほうを残す（先に来たほうではなく）',
      plan.boundaries.length === 1 && dropped.every((r) => r.distance <= kept.distance),
      `残した ${kept?.distance.toFixed(3)} / 落とした ${dropped.map((r) => r.distance.toFixed(3)).join(',')}`,
    );
  }

  {
    // 最短シーン長とちょうど同じ間隔で切り替わる素材。丸め誤差で落ちてはいけない。
    const every = 6;
    const frames = Array.from({ length: 90 }, (_, i) => {
      const shot = Math.floor(i / every) % 3;
      return solid([20, 130, 240][shot], [20, 130, 240][shot], [20, 130, 240][shot]);
    });
    const plan = planSceneCut(statsOf(frames), { minScene: every / 15, straddleFrames: 2 });
    check(
      'ちょうど最短シーン長と同じ間隔の切り替わりは、丸め誤差で落ちない',
      plan.boundaries.length === 14,
      `${plan.boundaries.length} 本（14 本あるはず）`,
    );
  }

  {
    // 頭と尻の 1 コマだけが違う素材。1 コマだけの場面を作らせない。
    const frames = [
      solid(250, 250, 250),
      ...Array.from({ length: 28 }, () => solid(40, 40, 40)),
      solid(250, 250, 250),
    ];
    const plan = planSceneCut(statsOf(frames), { straddleThreshold: 0 });
    check(
      '頭と尻に 1 コマだけの場面は作らない',
      plan.boundaries.length === 0 && plan.rejected.filter((r) => r.reason === 'minScene').length === 2,
      `${plan.boundaries.length} 本 / 落とした ${plan.rejected.filter((r) => r.reason === 'minScene').length}`,
    );
  }

  // --- 継ぎ目: auto-cut の edits.ts へそのまま渡せる ---
  {
    const frames = [
      ...Array.from({ length: 15 }, () => solid(30, 30, 30)),
      ...Array.from({ length: 15 }, () => solid(120, 200, 80)),
      ...Array.from({ length: 15 }, () => solid(240, 240, 240)),
    ];
    const plan = planSceneCut(statsOf(frames));
    const placement = { start: 5, duration: 3, sourceIn: 0 };
    const edits = toClipEdits(plan.scenes, placement);
    const total = edits.reduce((s, e) => s + e.duration, 0);
    const contiguous = edits.every((e, i) => i === 0 || approx(e.start, edits[i - 1].start + edits[i - 1].duration, 1e-9));
    check(
      '場面をそのまま edits.ts へ渡すと、尺を 1 秒も減らさずに割れる',
      edits.length === plan.scenes.length && approx(total, placement.duration, 1e-9) && contiguous,
      `${edits.length} 本 / 合計 ${total.toFixed(3)}s（もと ${placement.duration}s）`,
    );
  }

  {
    // 速度を変えたクリップでも、継ぎ目が尺を取り違えないこと。
    const frames = [
      ...Array.from({ length: 15 }, () => solid(30, 30, 30)),
      ...Array.from({ length: 15 }, () => solid(240, 240, 240)),
    ];
    const plan = planSceneCut(statsOf(frames));
    const placement = { start: 0, duration: 1, sourceIn: 0, speed: 2 };
    const edits = toClipEdits(plan.scenes, placement);
    const total = edits.reduce((s, e) => s + e.duration, 0);
    check(
      '2 倍速のクリップでも、割ったあとの尺の合計は変わらない',
      approx(total, placement.duration, 1e-9),
      `${total.toFixed(3)}s`,
    );
  }

  {
    // 格子（32×18）より小さいコマ。空の升目が出るが、両方に同じだけ出るので比べられる。
    const a = summarizeFrame(solid(20, 20, 20, 8, 5), 0);
    const b = summarizeFrame(solid(220, 220, 220, 8, 5), 1);
    check(
      '格子より小さいコマでも落ちず、距離は取れる',
      a.grid.length === GRID_W * GRID_H && gridDistance(a, b) > 0 && approx(lumaHistDistance(a, b), 1, 1e-9),
      `画素 ${gridDistance(a, b).toFixed(3)} / 分布 ${lumaHistDistance(a, b).toFixed(3)}`,
    );
  }

  {
    // **門は「候補を減らすだけ」ではない。**
    //
    // まとめ（連なりから 1 本を残す）を門より後ろに置いたので、門が連なりの一部を
    // 落とすと、**残るコマが入れ替わる**。ここでは 12 コマ目（門で落ちる）ではなく
    // 13 コマ目（窓が本物のカットへ届くので通る）が残る。
    // 部分集合になると思い込んで書いた検算が、その場で落ちて分かった。
    // 直せる穴ではない（順番をどちらにしても別の取り違えが出る）ので、
    // **いまの振る舞いのほうを固定しておく**。黙って変わったら気づけない。
    const frames = [
      ...Array.from({ length: 12 }, () => solid(40, 40, 40)),
      solid(255, 255, 255),
      ...Array.from({ length: 6 }, () => solid(40, 40, 40)),
      ...Array.from({ length: 12 }, () => solid(210, 180, 90)),
    ];
    const stats = statsOf(frames);
    const gated = planSceneCut(stats).boundaries.map((b) => b.frame);
    const open = planSceneCut(stats, { straddleThreshold: 0 }).boundaries.map((b) => b.frame);
    check(
      '門は候補を減らすが、連なりの中で残るコマは入れ替わりうる',
      gated.length === open.length && gated[0] !== open[0] && gated[1] === open[1],
      `門あり [${gated.join(',')}] / 門なし [${open.join(',')}]`,
    );
  }

  {
    // またぐ窓が本物のカットに届くと、そのすぐ手前のフラッシュを通してしまう。
    // **分かっている穴**なので、直せないうちは検算に固定しておく（黙って直ったら気づけない）。
    const frames = [
      ...Array.from({ length: 20 }, () => solid(40, 40, 40)),
      solid(255, 255, 255),
      solid(40, 40, 40),
      ...Array.from({ length: 20 }, () => solid(200, 120, 60)),
    ];
    const plan = planSceneCut(statsOf(frames), { minScene: 0.06 });
    check(
      'またぐ窓が本物のカットに届くと、近くのフラッシュは門をすり抜ける（穴として固定）',
      plan.boundaries.length === 2,
      `${plan.boundaries.length} 本（${plan.boundaries.map((b) => b.frame).join(',')} コマ目）`,
    );
  }

  // --- その場と比べる線（2026-09-22・縦型で測って足した） ---

  {
    // 素直な形。周りが静かなら、1 コマだけ跳ねた所の比は大きくなる。
    const d = [0, 0.01, 0.01, 0.5, 0.01, 0.01, 0.01, 0.01, 0.01];
    check(
      'その場と比べる比は、周りが静かなら大きく立つ',
      localRatioAt(d, 3, 30, 0.002) === 50,
      `${localRatioAt(d, 3, 30, 0.002)} 倍`,
    );
  }

  {
    // **この門の肝。** ずっと同じだけ動き続けていると、跳ねていなくても大きさは出る。
    // そこを大きさで見ると通ってしまうので、比で見る。
    const d = Array.from({ length: 40 }, (_, i) => (i === 0 ? 0 : 0.14));
    check(
      'ずっと動き続けている所では、大きくても比は 1 倍',
      Math.abs(localRatioAt(d, 20, 30, 0.002) - 1) < 1e-12,
      `${localRatioAt(d, 20, 30, 0.002)} 倍`,
    );
  }

  {
    // 平均ではなく中央値にした理由。0.4 秒ごとに跳ねる素材で、跳ねた側が周りを引き上げると
    // **自分で自分を隠す**。中央値なら跳ねが少数派のあいだは動かない。
    const d = Array.from({ length: 61 }, (_, i) => (i === 0 ? 0 : i % 6 === 0 ? 0.5 : 0.01));
    const mean = (() => {
      let sum = 0;
      let n = 0;
      for (let j = 1; j < d.length; j += 1) {
        if (Math.abs(j - 30) <= 1) continue;
        sum += d[j];
        n += 1;
      }
      return d[30] / (sum / n);
    })();
    check(
      '周りの代表値は中央値。平均だと跳ねの多い素材で自分を隠す',
      localRatioAt(d, 30, 30, 0.002) === 50 && mean < 7,
      `中央値 ${localRatioAt(d, 30, 30, 0.002)} 倍 / 平均 ${mean.toFixed(1)} 倍`,
    );
  }

  {
    // 自分の左右 1 コマを数えない理由。渡りの縁は「周り」ではなく本人の一部。
    const d = [0, 0.01, 0.01, 0.3, 0.5, 0.3, 0.01, 0.01, 0.01];
    check(
      '渡りの縁は周りに数えない（左右 1 コマを外す）',
      localRatioAt(d, 4, 2, 0.002) === 50,
      `${localRatioAt(d, 4, 2, 0.002)} 倍`,
    );
  }

  {
    // 素材が数コマしか無いと周りが取れない。**分からないときに落とすのはこの門の仕事ではない。**
    check(
      '周りが取れないときは通す側へ倒す（落とさない）',
      localRatioAt([0, 0.5], 1, 30, 0.002) === Infinity,
      `${localRatioAt([0, 0.5], 1, 30, 0.002)}`,
    );
    // 最短シーン長のほうが先に効かないよう、そちらは下げてある（見たいのは比の側）。
    const two = planSceneCut(statsOf([solid(10, 10, 10), solid(230, 40, 200)]), { minScene: 0.06 });
    check(
      '2 コマだけの素材でも、その場と比べる線で黙って消えない',
      two.boundaries.length === 1,
      `${two.boundaries.length} 本`,
    );
  }

  {
    // 先頭の 0 は測った値ではないので、周りに混ぜない。混ざると頭だけ門が甘くなる。
    const d = [0, 0.14, 0.14, 0.14, 0.14, 0.14];
    check(
      '先頭の 0 は周りに数えない（素材の頭で門が甘くならない）',
      Math.abs(localRatioAt(d, 3, 30, 0.002) - 1) < 1e-12,
      `${localRatioAt(d, 3, 30, 0.002)} 倍`,
    );
  }

  {
    // 門が実際に効くこと。ずっと動き続けている列の中の 1 コマは、大きさでは通るが比で落ちる。
    // 縞をずらす形では駄目だった。巻き戻してずらすと**分布が原理的に動かない**ので、
    // 候補が 1 本も立たず「門が効いた」と「そもそも何も無かった」が見分けられない。
    // 毎コマ明るさが段ぶん変わる列にすると、距離は毎コマ 1.0 まで立つのに
    // **周りも同じだけ高い**——この門が狙っているのはまさにその形。
    const frames = Array.from({ length: 40 }, (_, i) => solid(8 * i, 8 * i, 8 * i));
    const stats = statsOf(frames);
    const gated = planSceneCut(stats, { localRatio: 4 });
    const open = planSceneCut(stats, { localRatio: null });
    const localRejects = gated.rejected.filter((r) => r.reason === 'local').length;
    // **見るのは境界の本数ではなく、落とした理由のほう。** この列は毎コマ動くので
    // 候補が 1 本に繋がってしまい、最短シーン長の段でどちらにせよ 0 本になる。
    // 「0 本だから門が効いた」と読むと、**何も起きていない場合と見分けられない。**
    check(
      'ずっと動き続けるだけの列は、大きさでは通って比で落ちる',
      localRejects >= 30 &&
        open.rejected.every((r) => r.reason !== 'local') &&
        sceneDistances(stats, 'combined')[20] > 0.9,
      `比で落ちた候補 ${localRejects} 本 / 隣どうしの距離 ${sceneDistances(stats, 'combined')[20].toFixed(3)}`,
    );
  }

  {
    check(
      '既定は、組み合わせた量・線 0.10・またぐ幅 6 コマ・その場と比べて 4 倍（窓 30 コマ）・最短 0.4 秒',
      DEFAULT_SCENE_CUT.metric === 'combined' &&
        DEFAULT_SCENE_CUT.threshold === 0.1 &&
        DEFAULT_SCENE_CUT.straddleFrames === 6 &&
        DEFAULT_SCENE_CUT.localRatio === 4 &&
        DEFAULT_SCENE_CUT.localWindow === 30 &&
        DEFAULT_SCENE_CUT.localFloor === 0.002 &&
        DEFAULT_SCENE_CUT.minScene === 0.4,
      JSON.stringify(DEFAULT_SCENE_CUT),
    );
  }

  return results;
}
