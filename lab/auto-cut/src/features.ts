/**
 * 「声らしさ」を測るための候補になる特徴量を、コマごとに並べる。
 *
 * どれを使うかは決め打ちにせず、正解の分かっている素材で
 * 実際にどれくらい分けられるかを測ってから選ぶ（probe.mjs）。
 * 思いつきで 1 つ選ぶと、たまたま手元の素材で効いただけのものを掴む。
 *
 * すべて loudness.ts と同じコマ割り（既定 20ms）に揃えてあるので、
 * 音量の列とそのまま並べて比べられる。
 */

import { fftScratch, magnitudes } from './fft.ts';
import { SILENCE_DB, type AudioLike, type LoudnessTrack } from './loudness.ts';

export interface FeatureTrack {
  hop: number;
  duration: number;
  /** 1 秒に何コマか。 */
  frameRate: number;
  /** 音量（dBFS）。loudness.ts と同じもの。 */
  level: Float32Array;
  /** 音量の揺れのうち、3〜6Hz（人が音節を刻む速さ）が占める割合。 */
  modulation: Float32Array;
  /** スペクトルの重心（Hz）。高いほど「明るい」音。 */
  centroid: Float32Array;
  /** スペクトルの平坦さ（0〜1）。1 に近いほど雑音的、0 に近いほど音程がある。 */
  flatness: Float32Array;
  /** 1 コマ前からのスペクトルの変化量。子音や打撃で跳ねる。 */
  flux: Float32Array;
  /** 声の帯域（300〜3400Hz）が全体に占める割合。 */
  voiceBand: Float32Array;
  /** ゼロ交差率。高いほど雑音的・高域寄り。 */
  zcr: Float32Array;
  /** 倍音らしさ。基本周波数の整数倍にどれだけ energy が乗っているか（0〜1）。 */
  harmonicity: Float32Array;
  /** 音色の尖り具合（= 1 - flatness）。声や楽音で高く、雑音や打撃で低い。 */
  tone: Float32Array;
  /**
   * 声らしさ。揺れの速さ（modulation）と音色の尖り具合（tone）の積。
   *
   * 片方だけでは足りないことが probe.mjs で分かったので掛け合わせている。
   * - modulation は BGM が大きい素材でよく効くが、声と同じ速さで刻む打楽器には無力
   * - tone は打楽器をきれいに弾くが、BGM が大きいと鈍る
   * 互いの穴が重ならないので、積を取ると両方でそこそこ効く。
   */
  speechScore: Float32Array;
}

/** 窓の長さ（サンプル）。2048 なら 44.1kHz で約 46ms。音節より短く、母音より長い。 */
const WINDOW = 2048;
/** 音節の速さとみなす帯域（Hz）。 */
const MOD_LOW = 3;
const MOD_HIGH = 6;
/** 揺れを見る窓の長さ（秒）。短いと音節 1 つぶんも入らない。 */
const MOD_WINDOW = 1.0;
/** 人の声の基本周波数として探す範囲（Hz）。 */
const F0_LOW = 70;
const F0_HIGH = 320;
/**
 * 声らしさの谷を埋める窓の長さ（秒）。
 *
 * 窓を広げるほど声を取りこぼさなくなるが、余計なものも残るようになる。
 * 実測（lab:bench の speech-drums.wav「声を残せた率 / 残したうち声だった率」）:
 *   窓なし 85% / 95%   0.06s 90% / 92%   0.10s 92% / 91%   0.15s 95% / 86%   0.25s 100% / 76%
 * **声を切ってしまうのは取り返しがつかない**（余分な無音はあとから詰められる）ので、
 * 取りこぼさない側へ寄せつつ、切れ味が落ちきらない 0.10 を選んだ。
 * なお平均で均すと端が引きずられて逆に悪化した（0.25s で 71%）。最大値で谷だけを埋める。
 */
const SCORE_SMOOTH = 0.1;

/** 窓の中の最大値で埋める。谷を埋めるが、山（＝声のある所）は削らない。 */
function smooth(values: Float32Array, halfWidth: number): Float32Array {
  if (halfWidth < 1) return values;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let best = 0;
    for (let k = -halfWidth; k <= halfWidth; k += 1) {
      const v = values[Math.max(0, Math.min(values.length - 1, i + k))];
      if (v > best) best = v;
    }
    out[i] = best;
  }
  return out;
}

/**
 * 音量の列から、3〜6Hz の揺れが占める割合を出す。
 *
 * 人がしゃべると、音量が 1 秒に 3〜6 回くらい上下する（音節の速さ）。
 * 伸ばしっぱなしの音楽や環境音にはこの揺れが無い……というのが狙いだが、
 * 同じ速さで刻む打楽器には引っかかる。そこは probe.mjs で確かめる。
 */
export function modulationRatio(track: LoudnessTrack, low = MOD_LOW, high = MOD_HIGH, windowSeconds = MOD_WINDOW): Float32Array {
  const fs = 1 / track.hop;
  // 窓は 2 の冪に丸める。FFT の格子と欲しい周波数をきちんと合わせるため。
  let n = 1;
  while (n * 2 <= Math.round(windowSeconds * fs)) n *= 2;
  n = Math.max(16, n);

  const out = new Float32Array(track.db.length);
  const scratch = fftScratch(n);
  const buffer = new Float64Array(n);
  const lowBin = Math.max(1, Math.round((low * n) / fs));
  const highBin = Math.min(n / 2, Math.round((high * n) / fs));

  for (let i = 0; i < track.db.length; i += 1) {
    // 端は値を引き伸ばして埋める。窓の長さを変えると FFT の格子がずれるため。
    let mean = 0;
    for (let k = 0; k < n; k += 1) {
      const at = Math.max(0, Math.min(track.db.length - 1, i - (n >> 1) + k));
      // 無音の底（-100dB）がそのまま入ると、そこだけで巨大な段差になる。
      buffer[k] = Math.max(SILENCE_DB + 40, track.db[at]);
      mean += buffer[k];
    }
    mean /= n;
    let total = 0;
    for (let k = 0; k < n; k += 1) {
      buffer[k] -= mean;
      total += buffer[k] * buffer[k];
    }
    if (total < 1e-6) {
      out[i] = 0;
      continue;
    }
    magnitudes(buffer, scratch.re, scratch.im, scratch.mag);
    let band = 0;
    for (let b = lowBin; b <= highBin; b += 1) band += scratch.mag[b] * scratch.mag[b];
    // 窓を掛けたぶん全体のエネルギーが落ちるので、割合として見るために
    // 同じ窓を掛けた全帯域の合計で割る。
    let all = 0;
    for (let b = 1; b <= n / 2; b += 1) all += scratch.mag[b] * scratch.mag[b];
    out[i] = all > 0 ? Math.min(1, band / all) : 0;
  }
  return out;
}

/** 基本周波数の整数倍にどれだけ乗っているか。声は倍音が並ぶ、打楽器は並ばない。 */
function harmonicityOf(mag: Float64Array, binHz: number): number {
  const from = Math.max(1, Math.round(F0_LOW / binHz));
  const to = Math.min(mag.length - 1, Math.round(F0_HIGH / binHz));
  let total = 0;
  for (let b = 1; b < mag.length; b += 1) total += mag[b] * mag[b];
  if (total <= 0) return 0;

  let best = 0;
  for (let f0 = from; f0 <= to; f0 += 1) {
    let sum = 0;
    // 5 倍音まで。それ以上は伸ばしても差が出ないわりに重くなる。
    for (let h = 1; h <= 5; h += 1) {
      const b = f0 * h;
      if (b >= mag.length) break;
      // 隣も拾う（ピークが格子の間に落ちることがある）。
      const peak = Math.max(mag[b - 1] ?? 0, mag[b], mag[b + 1] ?? 0);
      sum += peak * peak;
    }
    if (sum > best) best = sum;
  }
  return Math.min(1, best / total);
}

export function analyzeFeatures(buffer: AudioLike, track: LoudnessTrack): FeatureTrack {
  const step = Math.max(1, Math.round(track.hop * buffer.sampleRate));
  const frames = track.db.length;
  const scratch = fftScratch(WINDOW);
  const window = new Float32Array(WINDOW);
  const binHz = buffer.sampleRate / WINDOW;

  const centroid = new Float32Array(frames);
  const flatness = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const voiceBand = new Float32Array(frames);
  const zcr = new Float32Array(frames);
  const harmonicity = new Float32Array(frames);

  // 1ch にまとめる（左右で結論が変わる場面は想定していない）。
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
  const mono = (i: number) => {
    let v = 0;
    for (const data of channels) v += data[i] ?? 0;
    return v / channels.length;
  };

  const previous = new Float64Array(scratch.mag.length);
  const lowBin = Math.round(300 / binHz);
  const highBin = Math.min(scratch.mag.length - 1, Math.round(3400 / binHz));

  for (let i = 0; i < frames; i += 1) {
    const center = i * step + step / 2;
    const from = Math.round(center - WINDOW / 2);
    for (let k = 0; k < WINDOW; k += 1) {
      const at = from + k;
      window[k] = at >= 0 && at < buffer.length ? mono(at) : 0;
    }

    // ゼロ交差は窓を掛ける前の生の並びで数える。
    let crossings = 0;
    for (let k = 1; k < WINDOW; k += 1) {
      if ((window[k - 1] >= 0) !== (window[k] >= 0)) crossings += 1;
    }
    zcr[i] = crossings / WINDOW;

    magnitudes(window, scratch.re, scratch.im, scratch.mag);
    const mag = scratch.mag;

    let sum = 0;
    let weighted = 0;
    let logSum = 0;
    let bandSum = 0;
    let diff = 0;
    let counted = 0;
    for (let b = 1; b < mag.length; b += 1) {
      const m = mag[b];
      sum += m;
      weighted += m * b * binHz;
      logSum += Math.log(m + 1e-12);
      counted += 1;
      if (b >= lowBin && b <= highBin) bandSum += m;
      const d = m - previous[b];
      if (d > 0) diff += d; // 増えたぶんだけ見る（減衰は「変化」として数えない）
      previous[b] = m;
    }

    centroid[i] = sum > 0 ? weighted / sum : 0;
    // 平坦さ＝幾何平均 ÷ 算術平均。雑音なら 1 に近づき、音程があると 0 に近づく。
    flatness[i] = sum > 0 ? Math.exp(logSum / counted) / (sum / counted) : 0;
    flux[i] = sum > 0 ? diff / sum : 0;
    voiceBand[i] = sum > 0 ? bandSum / sum : 0;
    harmonicity[i] = harmonicityOf(mag, binHz);
  }

  const modulation = modulationRatio(track);
  const tone = new Float32Array(frames);
  const raw = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    tone[i] = 1 - flatness[i];
    raw[i] = modulation[i] * tone[i];
  }
  // 人がしゃべっている間は続けてしゃべっている。1 コマだけ下がったからといって
  // そこで切ると、語中で切り刻むことになる。少し均してから使う。
  const speechScore = smooth(raw, Math.max(1, Math.round(SCORE_SMOOTH / track.hop)));

  return {
    hop: track.hop,
    duration: track.duration,
    frameRate: 1 / track.hop,
    level: track.db,
    modulation,
    centroid,
    flatness,
    flux,
    voiceBand,
    zcr,
    harmonicity,
    tone,
    speechScore,
  };
}

/** probe.mjs から名前で回せるように。 */
export const FEATURE_NAMES = [
  'level',
  'modulation',
  'flatness',
  'tone',
  'centroid',
  'zcr',
  'harmonicity',
  'speechScore',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
