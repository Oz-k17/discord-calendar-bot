/**
 * 立ち上がりの列から、テンポ（BPM）と拍の位置を出す。
 *
 * `onset.ts` が作った列だけを見る。元の音は見ない。
 * 実際にカットを置くのは呼び出し側で、ここは**秒の並びを返すだけ**なので、
 * タイムラインの実装が変わっても使い回せる（`scene.ts` と同じ形）。
 *
 * ## なぜ自己相関に重みを掛けるのか（2026-09-21 に測って決めた）
 *
 * 素の自己相関でいちばん高い山を選ぶと、**8 分のハットが拍より目立つ素材で倍のテンポを答える**。
 * 数字は `npm run lab:beat:probe` の 2 段目にある。
 * 重みは「速すぎる／遅すぎるテンポを人は取らない」という**外から持ってきた仮定**で、
 * 素材の中から出てくるものではない。素材の中から出せないものは外から入れるしかない、
 * というのは 2026-09-18（3 回目）に倍率の基準で確かめたのと同じ形をしている。
 */

import type { OnsetTrack } from './onset.ts';

export interface TempoOptions {
  /**
   * テンポの選び方。
   * - `comb`（既定）: 自己相関を**その周期の倍数ぶんまとめて**見る。重み付きで選ぶ
   * - `acfPrior`: 自己相関に重みを掛けて選ぶ
   * - `acf`: 自己相関のいちばん高い山をそのまま選ぶ
   */
  method: 'comb' | 'acfPrior' | 'acf';
  /** 探すテンポの下限・上限（BPM）。 */
  minBpm: number;
  maxBpm: number;
  /**
   * 自己相関を何で割るか。
   * - `total`（既定）: 列の長さで割る。**長い周期ほど自然に小さくなる**
   * - `count`: 実際に足した回数で割る。理屈は素直だが、**遅い側が暴れる**
   *
   * `count` が素直に見えるのは、遅いテンポほど足す回数が少なくなるぶんを
   * 戻してやる、という理屈が立つから。実際にやると**下限の BPM に山が立つ**
   * （2026-09-21 に測った。`jitter-118` と `quiet-124` が揃って 60.0 と答える）。
   * 足す回数が少ない所はもともと当てにならないので、戻すと雑音を持ち上げるだけになる。
   */
  acfNorm: 'total' | 'count';
  /** `comb` で何倍まで見るか。 */
  harmonics: number;
  /**
   * 重みの中心（BPM）と幅（オクターブ）。
   *
   * 中心を 120 にしてあるのは、人が「速い／遅い」と感じる真ん中がそのあたりだから。
   * **素材から出した値ではない。** ここは入力への仮定なので、外から変えられるようにしてある。
   */
  priorBpm: number;
  priorOctaves: number;
  /**
   * 拍を近くの立ち上がりへ寄せるか（`snapWindow` は拍の何分の 1 まで動かすか）。
   *
   * **測って捨てた**（2026-09-21・既定は寄せない）。人が叩いた揺れ（`jitter-118`）や
   * ハネ（`swing-104`）を拾えるはずだと思って入れたが、F 値の平均は
   * 寄せない 0.875 / 1/16 0.872 / 1/8 0.867 / 1/4 0.864 / 1/2 0.812 で、**寄せるほど下がる**。
   *
   * 理由は 2 つあった。**揺れのほうが許容幅より小さい**（±18ms 対 ±70ms）ので、
   * 寄せなくても最初から当たっている。そして寄せると
   * **声のある素材で拍が偽の打点へ吸われる**（`speech-over-110` が 0.759 → 0.690）。
   * 直したい相手が許容幅の中に収まっているとき、寄せる手は得が無く損だけがある。
   * 残してあるのは、許容幅を詰めたときに話が変わりうるため。
   */
  snapToPeak: boolean;
  snapWindow: number;
  /**
   * 「拍がある」と言うための下限（山の高さ ÷ 平均）を、**16 秒の素材で測ったときの値**で指定する。
   *
   * これを下回ったら拍の列を返さない。**何かを答えてしまうより、
   * 「無い」と言えるほうが使う側は助かる**（曲に合わせてカットを置く機能は、
   * 拍が無い素材では黙って引っ込むのが正しい）。0 にすると線を外す。
   *
   * **この線は固定値では引けない。尺で動く**（2026-09-21 に測って分かった）。
   * 拍がまったく無い雑音でも、短い素材では高い山がたまたま立つ:
   *
   * | 尺 | 雑音だけの「はっきりさ」の最大 | 拍のある素材の最小 | この線 |
   * | --- | --- | --- | --- |
   * | 4 秒 | 2.59 | 3.64 | 2.80 |
   * | 8 秒 | 1.76 | 2.70 | 2.27 |
   * | 16 秒 | 1.48 | 2.23 | 1.90 |
   * | 96 秒 | 1.28 | — | 1.37 |
   *
   * 自己相関は遠い所ほど足す回数が減るので、短い素材では**繰り返しを数回しか見ていない**。
   * 見た回数が少なければ、雑音でも揃って見えることがある。
   * そこで `1 + (この値 - 1) × √(16 ÷ 尺)` として、**見た回数の平方根で縮める**。
   * 16 秒を基準にしたのは、素材がその長さだから。
   *
   * **最初は 1.8 の固定値で入れていて、検算に落とされた**（8 秒の雑音で 1.94 が出た）。
   * 素材が 1 つの長さしか無いと、尺で動く量を固定値だと思い込む。
   */
  minClarity: number;
}

export const DEFAULT_TEMPO: TempoOptions = {
  method: 'comb',
  minBpm: 60,
  maxBpm: 200,
  acfNorm: 'total',
  harmonics: 4,
  priorBpm: 120,
  priorOctaves: 0.9,
  snapToPeak: false,
  snapWindow: 8,
  minClarity: 1.9,
};

export interface TempoResult {
  /** 見つけたテンポ。拍が無ければ null。 */
  bpm: number | null;
  /** 拍 1 つの秒数。拍が無ければ null。 */
  period: number | null;
  /** 拍の秒の並び。拍が無ければ空。 */
  beats: number[];
  /** 選んだ山の高さ ÷ 探した範囲の平均。1 に近いほど「拍らしい繰り返しが無い」。 */
  clarity: number;
  /** BPM ごとの点数（表示と測定のため）。 */
  curve: { bpm: number; score: number }[];
  /** 最初の拍の秒。 */
  phase: number;
}

/**
 * 自己相関。`lag` はコマ数。
 *
 * 割り方で結果が変わる（`acfNorm` の注を参照）。既定は列の長さで割るほう。
 */
export function autocorrelation(values: Float64Array, maxLag: number, norm: 'total' | 'count' = 'total'): Float64Array {
  const out = new Float64Array(maxLag + 1);
  const n = values.length;
  for (let lag = 0; lag <= maxLag; lag += 1) {
    if (lag >= n) break;
    let sum = 0;
    for (let i = lag; i < n; i += 1) sum += values[i] * values[i - lag];
    out[lag] = sum / (norm === 'count' ? n - lag : n);
  }
  return out;
}

/** 重み。log2 で測った中心からの隔たりを、釣鐘形で落とす。 */
export function tempoPrior(bpm: number, centerBpm: number, octaves: number): number {
  if (octaves <= 0) return 1;
  const d = Math.log2(bpm / centerBpm) / octaves;
  return Math.exp(-0.5 * d * d);
}

/** 線を引く基準の尺（秒）。`minClarity` はこの長さで測ったときの値として書く。 */
export const CLARITY_REFERENCE_SECONDS = 16;

/**
 * 「拍がある」と言うための線を、素材の尺に合わせて動かす（`minClarity` の注を参照）。
 *
 * 短い素材ほど高くする。0 を渡したら線を外す（0 のまま返す）。
 */
export function clarityLine(minClarity: number, duration: number): number {
  if (minClarity <= 0) return 0;
  if (!(duration > 0)) return Infinity;
  return 1 + (minClarity - 1) * Math.sqrt(CLARITY_REFERENCE_SECONDS / duration);
}

/**
 * テンポと拍を出す。
 *
 * 素材が短すぎる・鳴っていない・拍が無い、のいずれでも落ちずに
 * 「拍は無い」（`bpm: null` / `beats: []`）を返す。
 */
export function estimateTempo(track: OnsetTrack, options: Partial<TempoOptions> = {}): TempoResult {
  const o = { ...DEFAULT_TEMPO, ...options };
  const values = track.detrended;
  const hop = track.hop;
  const empty: TempoResult = { bpm: null, period: null, beats: [], clarity: 0, curve: [], phase: 0 };
  if (values.length < 4 || hop <= 0) return empty;

  const minLag = Math.max(1, Math.floor(60 / o.maxBpm / hop));
  const maxLag = Math.min(values.length - 1, Math.ceil(60 / o.minBpm / hop));
  if (maxLag <= minLag) return empty;

  // **自己相関は上限の倍数ぶんまで取る。** `comb` がその先を見るため。
  const acf = autocorrelation(values, Math.min(values.length - 1, maxLag * o.harmonics), o.acfNorm);
  if (acf[0] <= 0) return empty;

  const curve: { bpm: number; score: number }[] = [];
  let bestLag = -1;
  let bestScore = -Infinity;
  let sumScore = 0;
  let count = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const bpm = 60 / (lag * hop);
    let raw = acf[lag];
    if (o.method === 'comb') {
      // その周期の 2 倍・3 倍…にも山があるかを併せて見る。
      // 1 つの山だけを見ると、たまたま高い所（倍のテンポなど）を掴む。
      // 重みを 1/h にしてあるのは、遠い倍数ほど当てにならないため。
      let sum = acf[lag];
      let weight = 1;
      for (let h = 2; h <= o.harmonics; h += 1) {
        const at = lag * h;
        if (at >= acf.length) break;
        sum += acf[at] / h;
        weight += 1 / h;
      }
      raw = sum / weight;
    }
    const score = o.method === 'acf' ? raw : raw * tempoPrior(bpm, o.priorBpm, o.priorOctaves);
    curve.push({ bpm, score });
    sumScore += score;
    count += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  const mean = count > 0 ? sumScore / count : 0;
  const clarity = mean > 0 ? bestScore / mean : 0;
  if (bestLag < 0 || !Number.isFinite(clarity) || clarity < clarityLine(o.minClarity, track.duration)) {
    return { ...empty, clarity: Number.isFinite(clarity) ? clarity : 0, curve };
  }

  // **山のてっぺんはコマの間にある。** 前後 1 コマと放物線を当てて、コマより細かく取る。
  // 10ms 刻みのままだと、BPM 120（50 コマ）で 1 コマ外すだけで 2.4 BPM ずれる。
  const period = refineLag(acf, bestLag) * hop;
  const bpm = 60 / period;

  const { phase, beats } = placeBeats(track, period, o);
  return { bpm, period, beats, clarity, curve, phase };
}

/** 山のてっぺんをコマの間まで取る（前後 1 コマに放物線を当てる）。 */
export function refineLag(acf: Float64Array, lag: number): number {
  const left = acf[lag - 1];
  const mid = acf[lag];
  const right = acf[lag + 1];
  if (left === undefined || right === undefined) return lag;
  const denom = left - 2 * mid + right;
  if (denom === 0) return lag;
  const shift = (0.5 * (left - right)) / denom;
  // 1 コマ以上動くのは山では無い（当てはめが破綻している）ので、そのときは動かさない。
  return Math.abs(shift) < 1 ? lag + shift : lag;
}

/**
 * 拍の位置を決める。
 *
 * 周期は決まっているので、あとは**どこから始まるか**だけ。
 * 1 周期ぶんの始まりを総当たりして、拍の上に乗る立ち上がりの合計がいちばん大きい所を選ぶ。
 *
 * **総当たりにしているのは、いちばん強い打点から始める手が裏拍で破れるから**
 * （`syncopated-128` はウラだけが強い。強い 1 点に合わせると、拍が半拍ずれる）。
 * 合計で見れば、弱くても数の多いオモテの側が勝つ……とは限らず、そこは測って確かめた。
 */
export function placeBeats(
  track: OnsetTrack,
  period: number,
  options: Partial<TempoOptions> = {},
): { phase: number; beats: number[] } {
  const o = { ...DEFAULT_TEMPO, ...options };
  const values = track.detrended;
  const hop = track.hop;
  const periodFrames = period / hop;
  if (!(periodFrames >= 1) || values.length === 0) return { phase: 0, beats: [] };

  let bestOffset = 0;
  let bestSum = -Infinity;
  const steps = Math.max(1, Math.round(periodFrames));
  for (let offset = 0; offset < steps; offset += 1) {
    let sum = 0;
    for (let at = offset; at < values.length; at += periodFrames) {
      sum += sample(values, at);
    }
    if (sum > bestSum) {
      bestSum = sum;
      bestOffset = offset;
    }
  }

  const beats: number[] = [];
  for (let at = bestOffset; at < values.length; at += periodFrames) {
    let frame = at;
    if (o.snapToPeak) frame = snap(values, at, periodFrames / o.snapWindow);
    const time = frame * hop;
    if (time <= track.duration) beats.push(Math.round(time * 1e6) / 1e6);
  }
  return { phase: beats.length > 0 ? beats[0] : 0, beats };
}

/** コマの間の値を線で取る。周期がコマ数で割り切れないため。 */
function sample(values: Float64Array, at: number): number {
  const i = Math.floor(at);
  if (i < 0 || i >= values.length) return 0;
  const frac = at - i;
  const next = i + 1 < values.length ? values[i + 1] : values[i];
  return values[i] * (1 - frac) + next * frac;
}

/**
 * 近くの立ち上がりへ寄せる。
 *
 * 人が叩いた揺れ（`jitter-118`）やハネ（`swing-104`）は均等な格子に乗らないので、
 * 格子のまま返すと ±70ms の許容幅を使い切ってしまう。
 * **動かす幅は拍の 8 分の 1 まで**に絞ってある。広げると隣の打点まで届いて、
 * 拍が打点の列へ吸い寄せられる（そこは測って決めた。README の「寄せ幅」の段）。
 */
function snap(values: Float64Array, at: number, window: number): number {
  const from = Math.max(0, Math.round(at - window));
  const to = Math.min(values.length - 1, Math.round(at + window));
  let best = at;
  let bestValue = sample(values, at);
  for (let i = from; i <= to; i += 1) {
    if (values[i] > bestValue) {
      bestValue = values[i];
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 窓ごとのテンポ（2026-09-21・2 回目）
//
// 上の `estimateTempo` は**素材まるごとで 1 つの BPM**を出す。
// テンポが途中で変わる素材では、どちらか片方に合って残り半分を落とす
// （`tempo-change-90-120` の F 値 0.667 がそれ）。
//
// **実装する前に、窓ごとのテンポがそもそも測れるのかを測った**（`lab:beat:probe` の 6 段目）。
// 窓・1 秒刻みで局所の正解と突き合わせると、ずれの中央値は
// 一定の素材で 0.0〜0.6%、坂の素材（`tempo-ramp-100-130`）でも 0.6% だった。
// **窓ごとのテンポはよく当たる。**
//
// **それでも既定にしていない**（`beats.ts` の `followTempo` の注に表がある）。
// 当たった周期で拍を並べると、平均の F 値は 0.922（追わない）に対して 0.882〜0.941。
// **追えることと、使えることは別だった。** 理由は 2 つ測れた:
//
//   1. **周期の誤差は足し算で溜まる。** 窓ごとの周期は 0.1〜0.5% しか外していないが、
//      30 拍ぶん足すとその 30 倍がそのまま秒のずれになる。引き戻し（`trackGain`）で
//      溜まりは止まるが、**一度半拍ずれると引き戻しの幅（拍の 1/8）では戻れない。**
//   2. **変わり目の場所そのものが偏る。** 窓が変わり目をまたぐと、その窓は
//      「秒で多いほう」ではなく**「打点の数で多いほう」**を答える。速いテンポは
//      同じ秒数でより多くの打点を出すので、変わり目はどちら向きでも速い側へ寄る。
//      実測では 90 → 120 が 0.0〜0.5 秒**早く**、120 → 90 が 0.5〜1.5 秒**遅れて**見える。
//      テンポの重み（`priorOctaves`）でも自己相関の割り方（`acfNorm`）でも動かない。
//      **つまみの問題ではなく、窓で測ることそのものの性質。**
// ---------------------------------------------------------------------------

export interface TempoCurveOptions extends TempoOptions {
  /**
   * 窓の長さ（秒）と刻み（秒）。
   *
   * **窓は「短いほど追える」ではない。** 4 秒まで縮めると `break-116`
   * （6〜10 秒は打点が止まる素材）で、ブレイクに丸ごと入る窓ができ、
   * はっきりさが 17 から 3.5 へ落ちて 140BPM と答える。
   * 逆に 8 秒まで伸ばすと坂（`tempo-ramp-100-130`）のずれが 0.6% → 1.9% に増える。
   *
   * **5 秒にしてあるが、余裕は 1 秒しか無い**（ブレイクが 4 秒なので、
   * 窓の端が 1 秒ぶんだけ打点に掛かる）。5 秒より長いブレイクのある素材では破れる。
   * 数字は `lab:beat:probe` の 6 段目にある。
   */
  windowSeconds: number;
  windowHop: number;
  /**
   * 窓のテンポを、素材ぜんたいのテンポのオクターブへ畳むか。
   *
   * 窓を短くすると**その窓だけ倍・半分に取る**ことがある。曲の途中でテンポが
   * 2 倍になることは稀なので、素材ぜんたいの答えに近いオクターブへ寄せておく。
   * 畳む幅を 1.4 倍にしてあるのは、90 → 120（1.33 倍）を**畳まずに通す**ため。
   */
  foldToGlobal: boolean;
  /**
   * 「この窓は当てにならない」と見なす、素材ぜんたいのはっきりさに対する割合。
   *
   * **絶対値では線を引けない**（2026-09-21・2 回目に測った）。はっきりさは
   * 素材によって 2.2（声が乗る）から 24.6（キックだけ）まで 10 倍以上開くので、
   * 固定値を置くと簡単な素材にしか当たらない。**同じ素材の中では比べられる**ので、
   * 素材ぜんたいの値に対する割合で見る。
   *
   * 当てにならない窓は**捨てて前後から補う**（下の `fillGaps`）。
   * 0 にすると線を外す（全部の窓を信じる）。
   */
  minWindowClarityRatio: number;
  /**
   * 1 歩ごとに、近くの立ち上がりへどれだけ引き戻すか（0〜1）。0 なら引き戻さない。
   *
   * **周期を足し合わせるだけでは位相が流れる**（2026-09-21・2 回目に測って分かった）。
   * 窓ごとの周期は 0.1〜0.5% しか外していないのに、30 拍ぶん足すと
   * その 30 倍がそのまま秒のずれになる。`tempo-ramp-100-130` は全拍が外れ（F 値 0.000）、
   * `tempo-change-90-120` は段をまたいだ所から 123ms ずれたまま**戻ってこなかった**。
   *
   * 9/21（1 回目）に「寄せる手は損しかない」と書いて捨てたが、
   * **あれは格子が流れない前提での話だった**（直したい揺れ ±18ms が許容幅 ±70ms の
   * 中に収まっていたので、寄せる得が無かった）。流れる格子では相手が許容幅の外にいる。
   * **同じ手でも、土台が変われば釣り合いが逆を向く。**
   */
  trackGain: number;
  /** 引き戻し先を探す幅（拍の何分の 1 まで）。広げると隣の打点まで届く。 */
  trackWindow: number;
  /**
   * 窓ごとのテンポを、いくつ並べた中央値で均すか（0 か 1 なら均さない）。
   *
   * 手がかりの薄い素材では**1 つの窓だけが大きく外れる**ことがある
   * （`speech-over-110` の窓の列は 146 / 136 / 128 / 128 / 114 / 113 …… / 80）。
   * 平均ではなく中央値にしてあるのは、**平均はその 1 つに引っぱられる**から。
   *
   * **測って、既定では切った**（2026-09-21・2 回目）。F 値の平均は窓の長さごとに
   * 4s 0.895 → 0.893 / 5s 0.941 → 0.939 / 6s 0.882 → 0.903 / 8s 0.915 → 0.915 で、
   * **良くなる長さと悪くなる長さが混ざる**。効いたり効かなかったりする均しは、
   * 効いていないのと同じ（どちらに転ぶかを決める根拠が手元に無い）。
   */
  smoothWindows: number;
}

export const DEFAULT_TEMPO_CURVE: TempoCurveOptions = {
  ...DEFAULT_TEMPO,
  windowSeconds: 5,
  windowHop: 1,
  foldToGlobal: true,
  minWindowClarityRatio: 0.35,
  trackGain: 0.5,
  trackWindow: 8,
  smoothWindows: 0,
};

export interface TempoCurve {
  /** 窓の中心の秒。 */
  times: Float64Array;
  /** その窓の拍 1 つの秒数。 */
  periods: Float64Array;
  /** その窓のはっきりさ（捨てた窓は 0）。 */
  clarities: Float64Array;
  /** 捨てて前後から補った窓の数。 */
  filled: number;
  /** 素材ぜんたいの答え（窓が 1 つも立たないときの落とし所）。 */
  global: TempoResult;
}

/**
 * 立ち上がりの列の一部を、同じ形のまま切り出す。
 *
 * `duration` を切り出した長さにしてあるのが肝で、そうしないと
 * 「拍は無い」の線（尺で動く）が**素材ぜんたいの尺で計算されてしまう**。
 * 6 秒の窓に 16 秒ぶんの甘い線を当てると、雑音だけの窓まで拍があることになる。
 */
export function sliceTrack(track: OnsetTrack, from: number, to: number): OnsetTrack {
  const i0 = Math.max(0, Math.min(track.detrended.length, Math.round(from / track.hop)));
  const i1 = Math.max(i0, Math.min(track.detrended.length, Math.round(to / track.hop)));
  const detrended = track.detrended.slice(i0, i1);
  const strength = track.strength.slice(i0, i1);
  const times = new Float64Array(i1 - i0);
  for (let i = 0; i < times.length; i += 1) times[i] = (i0 + i) * track.hop;
  return { hop: track.hop, duration: (i1 - i0) * track.hop, strength, detrended, times };
}

/** `bpm` を、`target` に近いオクターブへ畳む。`tolerance` 倍までは畳まない。 */
export function foldOctave(bpm: number, target: number, tolerance = 1.4): number {
  if (!(bpm > 0) || !(target > 0)) return bpm;
  let out = bpm;
  // 上限・下限は付けない。2 のべきで寄せるだけなので、何回か掛ければ必ず止まる。
  for (let i = 0; i < 8 && out > target * tolerance; i += 1) out /= 2;
  for (let i = 0; i < 8 && out < target / tolerance; i += 1) out *= 2;
  return out;
}

/**
 * 窓ごとにテンポを出して並べる。
 *
 * 当てにならない窓（はっきりさが素材ぜんたいの `minWindowClarityRatio` 倍に届かない・
 * そもそも拍が見つからない）は**その場を埋めずに空けておき、あとで前後から補う**。
 * 前の値をそのまま伸ばす形にしなかったのは、**ブレイクが素材の途中にあるとき、
 * 前後の両方から挟めるほうが素直**だから（`break-116` の 6〜10 秒がその形）。
 */
export function estimateTempoCurve(track: OnsetTrack, options: Partial<TempoCurveOptions> = {}): TempoCurve {
  const o = { ...DEFAULT_TEMPO_CURVE, ...options };
  const global = estimateTempo(track, o);
  const empty: TempoCurve = {
    times: new Float64Array(0),
    periods: new Float64Array(0),
    clarities: new Float64Array(0),
    filled: 0,
    global,
  };
  if (global.period == null || !(o.windowSeconds > 0) || !(o.windowHop > 0)) return empty;

  // 窓が素材に入りきらないときは、素材まるごとを 1 つの窓として扱う（追う意味が無い）。
  const span = Math.min(o.windowSeconds, track.duration);
  const starts: number[] = [];
  for (let from = 0; from + span <= track.duration + 1e-9; from += o.windowHop) starts.push(from);
  if (starts.length === 0) starts.push(0);

  const times = new Float64Array(starts.length);
  const periods = new Float64Array(starts.length);
  const clarities = new Float64Array(starts.length);
  const line = global.clarity * o.minWindowClarityRatio;

  for (let i = 0; i < starts.length; i += 1) {
    times[i] = starts[i] + span / 2;
    const local = estimateTempo(sliceTrack(track, starts[i], starts[i] + span), o);
    if (local.bpm == null || local.period == null || local.clarity < line) {
      periods[i] = 0; // 0 は「この窓は空き」の印。下で補う。
      clarities[i] = 0;
      continue;
    }
    const bpm = o.foldToGlobal ? foldOctave(local.bpm, global.bpm ?? local.bpm) : local.bpm;
    periods[i] = 60 / bpm;
    clarities[i] = local.clarity;
  }

  const filled = fillGaps(periods, global.period);
  medianSmooth(periods, o.smoothWindows);
  return { times, periods, clarities, filled, global };
}

/**
 * 空いた所（0）を前後から補う。返すのは補った個数。
 *
 * 前後の両方に値があれば線で結び、片側しか無ければその値を伸ばし、
 * どこにも無ければ素材ぜんたいの答えで埋める。
 */
export function fillGaps(periods: Float64Array, fallback: number): number {
  let filled = 0;
  let any = false;
  for (let i = 0; i < periods.length; i += 1) if (periods[i] > 0) any = true;
  if (!any) {
    for (let i = 0; i < periods.length; i += 1) periods[i] = fallback;
    return periods.length;
  }
  for (let i = 0; i < periods.length; i += 1) {
    if (periods[i] > 0) continue;
    let left = -1;
    for (let k = i - 1; k >= 0; k -= 1) if (periods[k] > 0) { left = k; break; }
    let right = -1;
    for (let k = i + 1; k < periods.length; k += 1) if (periods[k] > 0) { right = k; break; }
    if (left >= 0 && right >= 0) {
      const u = (i - left) / (right - left);
      periods[i] = periods[left] * (1 - u) + periods[right] * u;
    } else {
      periods[i] = periods[left >= 0 ? left : right];
    }
    filled += 1;
  }
  return filled;
}

/**
 * 並びを、いくつ並べた中央値で均す（その場で書き換える）。
 *
 * 端は幅が足りないぶんだけ縮めて取る。端だけ均さない形にすると、
 * **素材の頭と尻でだけ暴れ窓が生き残る**（そこは拍の列がいちばん当てにならない所でもある）。
 */
export function medianSmooth(values: Float64Array, width: number): void {
  if (!(width >= 2) || values.length === 0) return;
  const half = Math.floor(width / 2);
  const source = values.slice();
  const buf: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    buf.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(source.length - 1, i + half); k += 1) buf.push(source[k]);
    buf.sort((a, b) => a - b);
    values[i] = buf[Math.floor(buf.length / 2)];
  }
}

/** その秒での拍 1 つの秒数を、窓の並びから線で読む（窓の外は端の値）。 */
export function periodAt(curve: TempoCurve, time: number): number {
  const { times, periods } = curve;
  if (periods.length === 0) return curve.global.period ?? 0;
  if (periods.length === 1 || time <= times[0]) return periods[0];
  if (time >= times[times.length - 1]) return periods[periods.length - 1];
  let i = 1;
  while (i < times.length && times[i] < time) i += 1;
  const u = (time - times[i - 1]) / (times[i] - times[i - 1]);
  return periods[i - 1] * (1 - u) + periods[i] * u;
}

/**
 * 拍の位置を、**間隔が動くことを許して**決める。
 *
 * `placeBeats` と同じく「1 周期ぶんの始まりを総当たりして、拍の上に乗る立ち上がりの
 * 合計がいちばん大きい所を選ぶ」形だが、違いが 2 つある。
 *
 *   1. **1 歩ごとにその時刻の周期を読み直す**（窓ごとのテンポに追いつくため）。
 *   2. **1 歩ごとに近くの立ち上がりへ少し引き戻す**（`trackGain` の注。
 *      これが無いと、周期の小さな誤差が足し算で溜まって位相が流れる）。
 *
 * **`snapToPeak` はここでは見ない。** あれは並べ終えた格子を後から動かす手で、
 * 2. と役目が重なるうえ、引き戻しの効いた列をもう一度動かすと二重に寄せることになる。
 * 追う側で寄せ幅を変えたいときは `trackWindow` のほう。
 *
 * 総当たりの幅は**いちばん短い周期**にしてある。いちばん長い周期で回すと、
 * テンポが上がる素材で「同じ位相を 2 度試す」ことになり、遅いほうが先に当たって止まる。
 */
export function placeBeatsVarying(
  track: OnsetTrack,
  curve: TempoCurve,
  options: Partial<TempoCurveOptions> = {},
): { phase: number; beats: number[] } {
  const o = { ...DEFAULT_TEMPO_CURVE, ...options };
  const values = track.detrended;
  const hop = track.hop;
  if (values.length === 0 || hop <= 0) return { phase: 0, beats: [] };

  let shortest = Infinity;
  for (let i = 0; i < curve.periods.length; i += 1) {
    if (curve.periods[i] > 0) shortest = Math.min(shortest, curve.periods[i]);
  }
  if (!Number.isFinite(shortest)) shortest = curve.global.period ?? 0;
  if (!(shortest > 0)) return { phase: 0, beats: [] };

  const steps = Math.max(1, Math.round(shortest / hop));
  let best: number[] = [];
  let bestSum = -Infinity;
  for (let offset = 0; offset < steps; offset += 1) {
    const beats = walkBeats(track, curve, offset * hop, o);
    let sum = 0;
    for (const t of beats) sum += sample(values, t / hop);
    if (sum > bestSum) {
      bestSum = sum;
      best = beats;
    }
  }

  const beats = best.map((t) => Math.round(t * 1e6) / 1e6);
  return { phase: beats.length > 0 ? beats[0] : 0, beats };
}

/**
 * 始まりの秒から、その時刻の周期ぶんずつ歩く。歩きながら近くの山へ少し引き戻す。
 *
 * **周期は「いまいる所」で読む。** 次の拍の所で読むと自分を参照することになる。
 * 引き戻しは**次の拍に対してだけ**掛ける（いま置いた拍は動かさない）。
 * こうしておくと、引き戻した結果がそのまま次の歩幅の起点になるので、
 * ずれが溜まらずに 1 歩ぶんで打ち消される。
 */
function walkBeats(track: OnsetTrack, curve: TempoCurve, from: number, o: TempoCurveOptions): number[] {
  const values = track.detrended;
  const hop = track.hop;
  const out: number[] = [];
  let t = from;
  // 進まなくなったら止める（周期が 0 に潰れた場合の保険）。
  for (let guard = 0; t <= track.duration + 1e-9 && guard < 100000; guard += 1) {
    out.push(t);
    const step = periodAt(curve, t);
    if (!(step > 0)) break;
    let next = t + step;
    if (o.trackGain > 0 && o.trackWindow > 0 && next <= track.duration) {
      const peak = peakNear(values, hop, next, step / o.trackWindow);
      // **引き戻しすぎない。** 1 歩で全部合わせにいくと、偽の打点 1 つで格子ごと持っていかれる。
      if (peak != null) next += (peak - next) * o.trackGain;
    }
    t = next;
  }
  return out;
}

/** `at` の前後 `window` 秒でいちばん高い立ち上がりの秒。何も無ければ null。 */
function peakNear(values: Float64Array, hop: number, at: number, window: number): number | null {
  const from = Math.max(0, Math.round((at - window) / hop));
  const to = Math.min(values.length - 1, Math.round((at + window) / hop));
  let best = -1;
  let bestValue = 0;
  for (let i = from; i <= to; i += 1) {
    if (values[i] > bestValue) {
      bestValue = values[i];
      best = i;
    }
  }
  return best >= 0 ? best * hop : null;
}
