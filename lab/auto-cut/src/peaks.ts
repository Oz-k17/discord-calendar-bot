/**
 * 波形を描くための山と谷。
 *
 * 44100Hz の音を 1 サンプルずつ描くことはできないので、
 * 画面の横 1px ぶんに入るサンプルの最小値と最大値だけを取り出しておく。
 * これは「タイムラインのクリップに波形を出す」ときにもそのまま使える。
 */

import type { AudioLike } from './loudness.ts';

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  /** 1 バケットあたりの秒数。 */
  step: number;
}

export function buildPeaks(buffer: AudioLike, buckets: number): Peaks {
  const count = Math.max(1, Math.floor(buckets));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const per = buffer.length / count;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(i * per);
    const to = Math.min(buffer.length, Math.max(from + 1, Math.floor((i + 1) * per)));
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      for (let s = from; s < to; s += 1) {
        const v = data[s];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[i] = lo;
    max[i] = hi;
  }

  return { min, max, step: buffer.length / buffer.sampleRate / count };
}
