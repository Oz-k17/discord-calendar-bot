/**
 * 「いつ音が立ち上がったか」の列を作る（onset envelope）。
 *
 * 拍を見つける仕事は 2 段に分かれていて、ここは 1 段目。
 *   1. **立ち上がりの強さの列**を作る（ここ）
 *   2. その列の繰り返しからテンポと拍の位置を出す（`tempo.ts`）
 *
 * 分けてあるのは、**2 段目が 1 段目の中身を知らなくてよい**ようにするため。
 * どの量で立ち上がりを測るかは差し替えられるが、テンポの出し方は変わらない。
 *
 * DOM にも WebAudio にも依存しない（Node がそのまま実行できる）。
 * コマ割りは `auto-cut/src/loudness.ts` と同じ考え方だが、**刻みは半分の 10ms** にしてある。
 * 拍の位置を ±70ms で当てたいので、20ms 刻みだと丸めだけで許容幅の 3 分の 1 を使ってしまう。
 */

import { fftScratch, magnitudes } from '../../auto-cut/src/fft.ts';
import type { AudioLike } from '../../auto-cut/src/loudness.ts';

export interface OnsetOptions {
  /**
   * 何を見て「立ち上がった」と決めるか。どれが効くかは `lab:beat:probe` で測った。
   * - `energy`（既定）: 音量（dB）の増えたぶんだけ。**スペクトルを見ない**
   * - `flux`: スペクトルをそのまま引き算して、増えたぶんだけを足す
   * - `logFlux`: スペクトルを dB に直してから、増えたぶんだけを足す
   *
   * **凝った手のほうが負けた**（2026-09-21）。テンポの当たりは
   * energy 13/13・flux 12/13・logFlux 10/13 で、いちばん素朴な手がいちばん良い。
   * しかも 1 段目（拍の上にどれだけ集まるか）の平均は 3.03 / **3.10** / 2.92 で、
   * **打点を拾う力では flux のほうが上**。それでもテンポでは負ける。
   * **拍を出す仕事に要るのは「打点を 1 つ残らず拾うこと」ではなく
   * 「列が周期的であること」**で、そこは別の性質だった。
   * 1 段目だけを見て列を選んでいたら、逆の手を掴んでいた。
   * `logFlux` は 513 本の帯を dB に直してから足すので、鳴っていない帯の
   * 微かな揺れまで同じ重さで数える。打点は拾うが、**その間も埋まる**ので周期が薄くなる。
   *
   * 向き不向きもはっきり分かれた。`pad-only-96`（打点が無く和音が変わるだけ）は
   * energy だけが当て（95.8）、logFlux は「拍なし」と答える。
   * 逆に `speech-over-110`（声が乗る）は 1 段目で logFlux 3.76 対 energy 1.90 と
   * logFlux のほうが拍を拾えているのに、**テンポはどちらも当たる**。
   */
  method: 'energy' | 'flux' | 'logFlux';
  /** コマの刻み（秒）。 */
  hop: number;
  /** FFT の窓（サンプル）。2 の冪。 */
  window: number;
  /**
   * 引き算する相手を何コマ前にするか。
   *
   * 1 コマ（10ms）前だと、立ち上がりが窓（23ms）より短いときに
   * 「前の窓にも同じ音が入っている」ことになり、差が出ない。
   * 既定の 2 コマは 20ms 前で、窓 1 つぶんに近い。
   */
  lag: number;
  /**
   * 引く移動平均の幅（秒）。0 なら引かない。
   *
   * **ここが無いと 2 段目が働かない。** 立ち上がりの列は 0 以上の値しか取らないので、
   * そのまま自己相関を取ると「どの周期でも大きい」という直流成分に山が埋もれる。
   * 平均を引いて 0 の周りに散らしてから初めて、周期の山が見える。
   */
  smoothSeconds: number;
}

export const DEFAULT_ONSET: OnsetOptions = {
  method: 'energy',
  hop: 0.01,
  window: 1024,
  lag: 2,
  smoothSeconds: 1.5,
};

export interface OnsetTrack {
  hop: number;
  duration: number;
  /** 立ち上がりの強さ。0 以上。 */
  strength: Float64Array;
  /**
   * `strength` から移動平均を引いて 0 以上に切り直したもの。**2 段目はこちらを見る。**
   * 全体の大きさで割って揃えてあるので、素材の録音レベルでは動かない。
   */
  detrended: Float64Array;
  /** コマ番号 → 秒。 */
  times: Float64Array;
}

/** コマ番号 → 秒。窓の真ん中を指す（立ち上がりの時刻を半窓ぶん遅らせないため）。 */
function frameTime(index: number, hop: number): number {
  return index * hop;
}

/**
 * 立ち上がりの強さを並べる。
 *
 * `energy` だけはスペクトルを取らずに済むが、**分けて書いていない**。
 * 同じコマ割り・同じ窓で比べないと、手の違いではなくコマ割りの違いを測ってしまう。
 */
export function analyzeOnset(buffer: AudioLike, options: Partial<OnsetOptions> = {}): OnsetTrack {
  const o = { ...DEFAULT_ONSET, ...options };
  const step = Math.max(1, Math.round(o.hop * buffer.sampleRate));
  const hop = step / buffer.sampleRate;
  const size = o.window;
  const frames = Math.max(1, Math.ceil(buffer.length / step));
  const duration = buffer.length / buffer.sampleRate;

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));

  // 窓をまたいで混ぜた 1 本の列にしてから測る。片チャンネルだけ鳴っている素材でも拾うため。
  const mono = new Float64Array(buffer.length);
  for (const data of channels) for (let i = 0; i < buffer.length; i += 1) mono[i] += data[i] / channels.length;

  const scratch = fftScratch(size);
  const bins = size / 2 + 1;
  const slice = new Float64Array(size);
  // コマごとのスペクトル（必要なぶんだけ持ち回す）。
  const history: Float64Array[] = [];
  const strength = new Float64Array(frames);
  const times = new Float64Array(frames);

  for (let i = 0; i < frames; i += 1) {
    times[i] = frameTime(i, hop);
    // 窓はコマの中心に置く。端は 0 で埋める（素材の外は鳴っていないのと同じ）。
    const center = i * step;
    const from = center - size / 2;
    for (let s = 0; s < size; s += 1) {
      const at = from + s;
      slice[s] = at >= 0 && at < mono.length ? mono[at] : 0;
    }

    if (o.method === 'energy') {
      let sum = 0;
      for (let s = 0; s < size; s += 1) sum += slice[s] * slice[s];
      const db = toDb(Math.sqrt(sum / size));
      history.push(Float64Array.of(db));
    } else {
      magnitudes(slice, scratch.re, scratch.im, scratch.mag);
      const spec = new Float64Array(bins);
      if (o.method === 'logFlux') {
        // dB に直してから引き算する。小さな音の立ち上がりも同じ重さで数えたいため
        // （そのままの振幅で引くと、大きな音の揺れだけで列が埋まる）。
        for (let b = 0; b < bins; b += 1) spec[b] = toDb(scratch.mag[b] / (size / 2));
      } else {
        for (let b = 0; b < bins; b += 1) spec[b] = scratch.mag[b] / (size / 2);
      }
      history.push(spec);
    }

    const prev = history[i - o.lag];
    if (!prev) continue;
    const now = history[i];
    let sum = 0;
    for (let b = 0; b < now.length; b += 1) {
      const d = now[b] - prev[b];
      // **増えたぶんだけ**を足す。減ったぶんまで数えると、音が消える所にも山が立つ。
      if (d > 0) sum += d;
    }
    strength[i] = sum / now.length;

    // 使い終わったコマは捨てる（16 秒 × 1600 コマ × 513 要素を全部持つ必要は無い）。
    if (i - o.lag >= 0) history[i - o.lag] = new Float64Array(0);
  }

  return { hop, duration, strength, detrended: detrend(strength, o.smoothSeconds, hop), times };
}

/** 振幅（0〜1）を dB に。`loudness.ts` と同じ下限で止める。 */
function toDb(amplitude: number): number {
  if (amplitude <= 1e-10) return -200;
  return Math.max(-200, 20 * Math.log10(amplitude));
}

/**
 * 移動平均を引いて、0 以上に切り、全体の大きさで割る。
 *
 * 3 つとも別々の理由で要る:
 *   - **平均を引く**のは、自己相関の直流成分を落とすため（`smoothSeconds` の注）。
 *   - **0 で切る**のは、音が薄くなる所を「負の打点」と数えないため。
 *   - **割る**のは、素材の録音レベルで値が動かないようにするため。
 *     `quiet-124` は `band-100` を 0.04 倍しただけの素材で、ここが無いと数字が 25 分の 1 になる。
 */
export function detrend(strength: Float64Array, smoothSeconds: number, hop: number): Float64Array {
  const out = new Float64Array(strength.length);
  if (strength.length === 0) return out;

  if (smoothSeconds > 0) {
    const half = Math.max(1, Math.round(smoothSeconds / 2 / hop));
    // 累積和で移動平均を出す（窓ごとに足し直すと 1600 コマ × 150 コマになる）。
    const cumulative = new Float64Array(strength.length + 1);
    for (let i = 0; i < strength.length; i += 1) cumulative[i + 1] = cumulative[i] + strength[i];
    for (let i = 0; i < strength.length; i += 1) {
      const from = Math.max(0, i - half);
      const to = Math.min(strength.length, i + half + 1);
      const mean = (cumulative[to] - cumulative[from]) / (to - from);
      out[i] = Math.max(0, strength[i] - mean);
    }
  } else {
    for (let i = 0; i < strength.length; i += 1) out[i] = Math.max(0, strength[i]);
  }

  // 大きさを揃える。二乗平均で割るのは、最大で割ると 1 発の大きな音に全部を決められるため。
  let sum = 0;
  for (let i = 0; i < out.length; i += 1) sum += out[i] * out[i];
  const rms = Math.sqrt(sum / out.length);
  if (rms > 0) for (let i = 0; i < out.length; i += 1) out[i] /= rms;
  return out;
}
