/**
 * **横型の素材から縦型を切り出すとき、クロップ枠を被写体に合わせて動かす。**
 *
 * 決めるのは「各コマで、幅 `cropWidth` の窓を横のどこに置くか」の 1 本の列だけ。
 * 縦は切らない（9:16 を 16:9 から切るときに余るのは横だけ）ので、ここも横だけを持つ。
 *
 * ## 何を当てにしているか（probe で測ってから決めた。2026-09-24・3 回目）
 *
 * 被写体を指す手は **`spatial`（そのコマの中で色が浮いている列）＋ `peak`（いちばん強い所）**。
 * 7 本の素材のうち 6 本で、生の位置をそのまま枠の中心にするだけで**枠に入る率 100%**。
 * 引き算（動いた所を探す手）は、いちばん素直に見えて**いちばん悪い**——
 * カメラがパンしていると画面じゅうが動くので被写体の所だけが立つ理由が無く、
 * `subject-pan` で 2.5% まで落ちる。列をずらして打ち消しても 4.9% にしかならない。
 * 背景（列ごとの時間の中央値）と比べる手は動きに強いが、
 * **被写体が動かないと自分が背景になる**ので `subject-static` で 0.0%。
 *
 * ## ここから先が「追う」の中身
 *
 * 生の位置は**当たっているが落ち着きが無い**。そのまま枠にすると 1 コマごとに揺れて、
 * 出来上がりは手ぶれのひどい映像になる。かといって強くならすと、
 * 動き出した被写体に置いていかれる。**遅れと揺れは同じつまみの裏表**なので、
 * ここは「ならす」ではなく**いつ動かすかを決める**形にしてある:
 *
 *   1. 生の位置を**中央値**でならす（平均ではない。カットのコマで飛ぶ 1 点を落とすため）
 *   2. 枠の中心からのずれが `deadband` の内側なら**動かさない**
 *   3. 外へ出ても、`settle` 秒ぶん続けて同じ側に居るまでは動かさない
 *   4. 動き出したら `maxSpeed` を上限に寄せ、**真ん中に来るまで**寄せ切る
 *
 * 3 と 4 が対で、これが無いと枠は deadband の縁を這い続けて、
 * 「いつも少し遅れている」状態から抜けられない。
 */

import {
  COLUMNS,
  type ColumnStat,
  type FrameLike,
  type RowBand,
  readPeak,
  spatialOdds,
  summarizeAllColumns,
} from './columns.ts';

export interface ReframeOptions {
  /** 切り出す窓の幅（画面の幅に対する割合）。16:9 から 9:16 を切るなら 81/256 ≒ 0.316。 */
  cropWidth: number;
  /** 枠の中心からこのぶんまでのずれは、動かす理由にしない（画面の幅に対する割合）。 */
  deadband: number;
  /** 1 秒に動かしてよい幅（画面の幅 / 秒）。 */
  maxSpeed: number;
  /** 外へ出てから動き出すまでに要る時間（秒）。 */
  settle: number;
  /** 生の位置をならす窓（秒）。中央値を取る。 */
  smooth: number;
  /**
   * 列へ畳むときに見る縦の範囲。上下を落とすのは**焼き込みの字幕**のため。
   *
   * 短尺の動画は上下に字幕が焼かれていて、**1.5 秒ごとに書き換わる**。
   * 字幕は画面の一部しか占めないのに列の色を動かすので、
   * 「そこに何かある」を見る手がそれを拾って枠を引っぱる。
   * 上下 15% を落とすと `captions-only` の泳ぎが **0.077 → 0.010** まで落ち、
   * 追従はほとんど変わらない（`crossing-vertical` を除いた 6 本で 97.4% → 96.8%）。
   * **ここは「字幕がそこにある」という入力への仮定**なので、つまみとして残してある。
   */
  rowBand: RowBand;
  /**
   * 頭の置き所を、最初の `settle` 秒の中央値から決めるか。
   *
   * 真ん中から始めると、**右寄りに居続ける被写体では頭でかならず 1 回すべる**。
   * 編集では頭から最後まで素材が手元にあるので、始まる前に決めてよい。
   */
  leadIn: boolean;
}

/**
 * **この判定へ渡すコマの速さ**（fps）。シーン検出の `ANALYSIS_FPS`（15）とは別に持つ。
 *
 * ## なぜ 2 つ持つのか（2026-09-25・2 回目に測って決めた）
 *
 * `decode.ts` の `ANALYSIS_FPS` は「読み込みの既定」ではなく**シーン検出の単位**。
 * あちらは 15fps で線を引いてあり、速く読むと渡り（ディゾルブ）が薄まって見逃す。
 * **同じ 1 本の動画から、2 つの判定が別々の速さを欲しがる。**
 * なので「読む速さ」は読み込みの持ち物ではなく、**判定ごとの持ち物**にしてある。
 *
 * ## 30 にしたのは、当たるからではなく**振れないから**
 *
 * 1 回目（9/25）に「間引くと落ちる（92.6% 対 97.9%）」と書いたが、
 * **そのうち大半は測り方の穴だった。** 読む時刻をコマの頭に置いていたので、
 * 素材の速さの見積もりがほんの少し速いだけで列ぜんたいが 1 コマずれる
 * （`decode.ts` の `sampleTimes` の注）。直したうえで 7 本並べると、
 * **入れた率の平均は 15fps 読みも 30fps 読みも 96.5% で同じ。**
 *
 * 残るのは**振れ幅**のほう。中身も速さも変えずに焼くビットレートだけ 5 通り振ると
 * （粒はほとんど動かない）、入れた率はこうなる:
 *
 * | 素材 | 15fps 読み | 30fps 読み |
 * | --- | --- | --- |
 * | `motion` | 92.6〜98.4%（**5.7pt**） | 97.9〜98.4%（0.4pt） |
 * | `subject-decoy` | 92.6〜96.7%（**4.1pt**） | 96.3〜97.9%（1.6pt） |
 * | `subject-pan` / `subject-dart` | 0.0pt | 0.0pt / 0.0pt |
 *
 * **1 回目に見た 5.3 ポイントは、間引いた側の当たり外れ（5.7pt）の中に丸ごと入る。**
 * つまり「間引くと落ちる」は言えず、言えるのは「**間引くと、同じ動画を焼き直しただけで
 * 答えが数ポイント動く**」のほう。ならしは中央値なので、窓に入る標本が半分になると
 * 中央値が隣の値へ飛びやすくなり、その飛びを門（deadband / settle）が拡大する。
 *
 * 選んだのは**再現性のほう**——同じ素材を入れ直したら同じ枠が出てほしいので。
 * 払っているのは**読む時間 1.8 倍・メモリ 2 倍**、そして `MAX_ANALYSIS_FRAMES` に
 * 当たるまでの尺が 200 秒から 100 秒へ半分になること（短尺の道具なので飲んでいる）。
 *
 * 30 で止めてあるのは、そこで頭打ちになるから（`npm run lab:reframe:decimate`）:
 * 60fps で焼いた素材を 60fps で読んでも `motion` は 97.3% と上がらず、
 * 時間とメモリだけが倍になる。**素材の速さに合わせる（間引かない）を選ばなかった**のは、
 * それだと 120fps の素材で値段だけが 4 倍になるため。
 *
 * ## ならしの窓を広げる手は取らなかった
 *
 * 標本が足りないなら窓を広げればよい、という手もある（1 回目はそれを勧めていた）。
 * 測ると**窓より短い動きが中央値の中で少数派になって消える**——
 * `subject-dart`（0.8 秒の寄り道が 2 回）で、ならしたあとのずれが 0.005 → 0.173、
 * 寄り道のあいだの入れた率が 46.7% → 13.3%。**振れ幅も直らない。**
 *
 * **不安定の根は、標本の数ではなく門の側にある**（数コマの違いが
 * 「動き出す / 動かない」に化ける作り）。ここで増やしているのは、その上から被せた蓋。
 */
export const REFRAME_ANALYSIS_FPS = 30;

export const DEFAULT_REFRAME: ReframeOptions = {
  cropWidth: 81 / 256,
  deadband: 0.06,
  maxSpeed: 0.22,
  settle: 0.3,
  smooth: 1.0,
  rowBand: { from: 0.15, to: 0.85 },
  leadIn: true,
};

export interface ReframeFrame {
  time: number;
  /** 枠の中心（画面の幅に対する割合）。 */
  center: number;
  /**
   * その手が指した**生の位置**（`rawTargets` の値そのもの）。
   *
   * 下の `target` と 2 本持っているのは、**画面で見比べたときに意味が違うから**
   * （2026-09-25 に画面を作って気づいた）。生の位置が荒れているのか、
   * ならしが追い付いていないのかは、片方だけでは切り分けられない。
   */
  raw: number;
  /** 生の位置を中央値でならしたあと、枠を動かす条件へ入れる前の値。 */
  target: number;
  /** そのコマで枠を動かしたか。動いた秒数を数えるために持つ。 */
  moving: boolean;
}

export interface ReframePlan {
  frames: ReframeFrame[];
  options: ReframeOptions;
  /** 枠が動いた量の合計（画面の幅ぶん）。尺で割れば「1 秒あたりどれだけ泳いだか」。 */
  travel: number;
}

/**
 * コマの列を、**この手の都合で**畳む。
 *
 * `summarizeAllColumns` の既定は画面ぜんぶ（あちらは判断を置かない側）なので、
 * 「上下を落とす」という判断はこちらで足す。呼ぶ側が畳み方を選び違えると
 * 数字が静かにずれるので、入口を 1 つにしてある。
 */
export function summarizeForReframe(
  frames: FrameLike[],
  times: ArrayLike<number>,
  options: Partial<ReframeOptions> = {},
): ColumnStat[] {
  const opt = { ...DEFAULT_REFRAME, ...options };
  return summarizeAllColumns(frames, times, opt.rowBand);
}

/** 中央値。ならすのに平均を使わない理由は上の注に書いた。 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * 列の並びから、コマごとの**生の位置**を出す。
 *
 * ここだけ差し替えれば別の手を試せるように、枠を決める側とは分けてある。
 */
export function rawTargets(cols: ColumnStat[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < cols.length; i += 1) {
    const u = readPeak(spatialOdds(cols, i));
    // 指せなかったコマ（真っ黒など）は真ん中を答えにしない——**前の答えを引き継ぐ**。
    // 真ん中を返すと、黒へ落ちるフェードのあいだだけ枠が中央へ寄ってしまう。
    out.push(Number.isNaN(u) ? (out.length ? out[out.length - 1] : 0.5) : u);
  }
  return out;
}

/** 枠の置き所を決める。 */
export function planReframe(cols: ColumnStat[], options: Partial<ReframeOptions> = {}): ReframePlan {
  const opt = { ...DEFAULT_REFRAME, ...options };
  const frames: ReframeFrame[] = [];
  if (!cols.length) return { frames, options: opt, travel: 0 };

  const half = opt.cropWidth / 2;
  const lo = half;
  const hi = 1 - half;
  // 窓が画面より広ければ動かしようが無い（切り出す意味が無い）ので、真ん中で止める。
  if (lo >= hi) {
    for (const c of cols) frames.push({ time: c.time, center: 0.5, raw: 0.5, target: 0.5, moving: false });
    return { frames, options: opt, travel: 0 };
  }

  const raw = rawTargets(cols);
  // コマの速さは素材から読む（つまみは秒で書いてあるので、ここでコマ数へ直す）。
  const span = cols.length > 1 ? cols[cols.length - 1].time - cols[0].time : 0;
  const fps = span > 0 ? (cols.length - 1) / span : 30;
  const smoothFrames = Math.max(1, Math.round(opt.smooth * fps));

  // 中央値でならす。窓は前後へ同じだけ広げる（片側だけだと半窓ぶん遅れる）。
  const targets: number[] = [];
  const k = smoothFrames >> 1;
  for (let i = 0; i < raw.length; i += 1) {
    const from = Math.max(0, i - k);
    const to = Math.min(raw.length - 1, i + k);
    targets.push(median(raw.slice(from, to + 1)));
  }

  const settleFrames = Math.max(1, Math.round(opt.settle * fps));
  const step = opt.maxSpeed / fps;
  // 動き出したあと「どこまで寄せたら止めるか」。deadband の 4 分の 1 まで寄せ切る。
  // ここを deadband と同じにすると、枠は縁に触れた所で止まるので**いつも少し遅れる**。
  const stopBand = opt.deadband * 0.25;

  let center = 0.5;
  if (opt.leadIn) {
    const lead = targets.slice(0, Math.min(targets.length, Math.max(1, settleFrames)));
    center = median(lead);
  }
  center = Math.min(hi, Math.max(lo, center));

  let outside = 0;
  let moving = false;
  let travel = 0;
  for (let i = 0; i < cols.length; i += 1) {
    const want = Math.min(hi, Math.max(lo, targets[i]));
    const err = want - center;

    if (Math.abs(err) >= opt.deadband) outside += 1;
    else outside = 0;
    if (outside >= settleFrames) moving = true;
    // 寄せ切ったら止める。止める線を入れる側より内側にしてあるのがヒステリシス。
    if (moving && Math.abs(err) <= stopBand) moving = false;

    let next = center;
    if (moving) {
      next = center + Math.max(-step, Math.min(step, err));
      next = Math.min(hi, Math.max(lo, next));
    }
    travel += Math.abs(next - center);
    frames.push({ time: cols[i].time, center: next, raw: raw[i], target: targets[i], moving });
    center = next;
  }

  return { frames, options: opt, travel };
}

/** 枠を、クロップの矩形（0〜1 の左端と幅）として読む。本体のクロップへ渡す形。 */
export function toCropRects(plan: ReframePlan): { time: number; x: number; width: number }[] {
  const w = plan.options.cropWidth;
  return plan.frames.map((f) => ({ time: f.time, x: f.center - w / 2, width: w }));
}

/** 列の数。呼ぶ側が格子の細かさを知りたいときのため。 */
export { COLUMNS };
