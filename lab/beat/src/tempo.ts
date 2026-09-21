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
