/**
 * 音量の時間変化を測る。
 *
 * 波形をそのまま見ても「どこが声でどこが無音か」は分からないので、
 * 短い区間（hop）ごとの実効値（RMS）を dBFS に直した列を作る。
 * 以降の機能（無音カット・ダッキング・波形の色分け）はすべてこの列だけを見る。
 *
 * DOM にも WebAudio にも依存しないので、そのまま Node でも試せる。
 */

/** AudioBuffer と同じ形なら何でもよい（テスト用の合成波形もこの形で作る）。 */
export interface AudioLike {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export interface LoudnessTrack {
  /** 1 コマの長さ（秒）。 */
  hop: number;
  /** コマごとの音量（dBFS）。無音は SILENCE_DB。 */
  db: Float32Array;
  /** 元の音の長さ（秒）。 */
  duration: number;
}

/** これ以下は「完全な無音」として扱う下限。log10(0) を避けるためでもある。 */
export const SILENCE_DB = -100;

const HOP_DEFAULT = 0.02;

/** 振幅（0〜1）を dBFS に。 */
export function toDb(amplitude: number): number {
  if (amplitude <= 0) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(amplitude));
}

/**
 * hop 秒ごとの RMS を測る。
 * 全チャンネルを足して平均するのは、片チャンネルだけ鳴っている素材でも
 * 「鳴っている」と判定したいため。
 */
export function analyzeLoudness(buffer: AudioLike, hop = HOP_DEFAULT): LoudnessTrack {
  const step = Math.max(1, Math.round(hop * buffer.sampleRate));
  const frames = Math.max(1, Math.ceil(buffer.length / step));
  const db = new Float32Array(frames);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < frames; i += 1) {
    const from = i * step;
    const to = Math.min(buffer.length, from + step);
    let sum = 0;
    let count = 0;
    for (const data of channels) {
      for (let s = from; s < to; s += 1) {
        const v = data[s];
        sum += v * v;
      }
      count += to - from;
    }
    db[i] = toDb(count > 0 ? Math.sqrt(sum / count) : 0);
  }

  return { hop: step / buffer.sampleRate, db, duration: buffer.length / buffer.sampleRate };
}

/** 分位点。しきい値の自動決定に使う（平均だと拍手や息継ぎ 1 発で動いてしまう）。 */
export function percentileDb(track: LoudnessTrack, ratio: number): number {
  if (track.db.length === 0) return SILENCE_DB;
  const sorted = Float32Array.from(track.db).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

/** コマ番号 → 秒。 */
export function frameToTime(track: LoudnessTrack, frame: number): number {
  return Math.min(track.duration, frame * track.hop);
}
