/**
 * オートダッキング（声が入っているあいだ BGM を自動で下げる）。
 *
 * 無音カットと同じ「音量の列」を入力にして、今度は切るかわりに音量カーブを作る。
 * 返すのは {時刻, 音量} の並びなので、
 *   - プレビュー: gain.setValueAtTime / linearRampToValueAtTime にそのまま流す
 *   - 書き出し: OfflineAudioContext の GainNode に同じものを流す
 * のどちらでも同じ結果になる。
 */

import type { LoudnessTrack } from './loudness.ts';

export interface DuckOptions {
  /** 声があるときに BGM を何 dB 下げるか（負の値）。 */
  duckDb: number;
  /** 下げきるまでの時間（秒）。短すぎると「ヒュッ」と鳴る。 */
  attack: number;
  /** 戻しきるまでの時間（秒）。 */
  release: number;
  /** 声が途切れてから戻し始めるまでの待ち（秒）。息継ぎのたびに戻ると落ち着かない。 */
  hold: number;
  /** 声とみなすしきい値（dBFS）。 */
  thresholdDb: number;
}

export const DEFAULT_DUCK: DuckOptions = {
  duckDb: -12,
  attack: 0.12,
  release: 0.45,
  hold: 0.3,
  thresholdDb: -45,
};

export interface GainPoint {
  time: number;
  gain: number;
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

/**
 * 声が鳴っている区間を求める。
 * hold のぶん後ろへ伸ばしてから繋ぐので、短い息継ぎは 1 区間にまとまる。
 */
export function voiceRanges(voice: LoudnessTrack, thresholdDb: number, hold: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < voice.db.length; i += 1) {
    if (voice.db[i] <= thresholdDb) continue;
    const start = i * voice.hop;
    const end = Math.min(voice.duration, (i + 1) * voice.hop + hold);
    const last = out[out.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

/**
 * BGM に流す音量カーブ。
 * 連続する 2 点のあいだは直線で繋ぐ前提（linearRampToValueAtTime）。
 */
export function planDucking(voice: LoudnessTrack, options: Partial<DuckOptions> = {}): GainPoint[] {
  const opts = { ...DEFAULT_DUCK, ...options };
  const ducked = dbToGain(opts.duckDb);
  const ranges = voiceRanges(voice, opts.thresholdDb, opts.hold);
  if (ranges.length === 0) return [{ time: 0, gain: 1 }];

  const points: GainPoint[] = [];
  const push = (time: number, gain: number) => {
    const last = points[points.length - 1];
    // 同じ時刻に 2 点あると WebAudio 側で挙動が読みにくくなるので、後から来た方を採る。
    if (last && Math.abs(last.time - time) < 1e-4) last.gain = gain;
    else points.push({ time: Math.max(0, time), gain });
  };

  push(0, 1);
  for (const range of ranges) {
    // 下げ始めは「声より attack だけ前」。声が出た瞬間にはもう下がりきっている。
    push(Math.max(0, range.start - opts.attack), points[points.length - 1].gain);
    push(range.start, ducked);
    push(range.end, ducked);
    push(Math.min(voice.duration, range.end + opts.release), 1);
  }
  return points;
}

/** 任意の時刻の音量（グラフを描くときや、確かめるときに使う）。 */
export function gainAt(points: GainPoint[], time: number): number {
  if (points.length === 0) return 1;
  if (time <= points[0].time) return points[0].gain;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (time > b.time) continue;
    const span = b.time - a.time;
    if (span <= 0) return b.gain;
    return a.gain + ((b.gain - a.gain) * (time - a.time)) / span;
  }
  return points[points.length - 1].gain;
}

/** WebAudio の GainNode へそのまま流す。startAt は音を鳴らし始める時刻。 */
export function applyDucking(gain: AudioParam, points: GainPoint[], startAt: number) {
  if (points.length === 0) return;
  gain.setValueAtTime(points[0].gain, startAt + points[0].time);
  for (let i = 1; i < points.length; i += 1) {
    gain.linearRampToValueAtTime(points[i].gain, startAt + points[i].time);
  }
}
