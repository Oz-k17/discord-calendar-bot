/**
 * 無音カット（ジェットカット）の計画を立てる。
 *
 * やることは 4 段だけ:
 *   1. しきい値を決める（自動なら音量の分布から）
 *   2. しきい値を超えたコマを「鳴っている」とする
 *   3. 前後に余白を足し、短い切れ目は繋いで、鳴っている区間をまとめる
 *   4. 残りを「削る区間」とする
 *
 * 実際に切るのは呼び出し側（edits.ts）。ここは秒の並びを返すだけなので、
 * タイムラインの実装が変わっても使い回せる。
 */

import { percentileDb, SILENCE_DB, type LoudnessTrack } from './loudness';

export interface Range {
  start: number;
  end: number;
}

export interface JetCutOptions {
  /** しきい値（dBFS）。null なら音量の分布から自動で決める。 */
  thresholdDb: number | null;
  /** 自動しきい値の位置。0 = 無音の底ぎりぎり、1 = 声と同じ大きさ。 */
  sensitivity: number;
  /** これより短い無音は繋いだままにする（秒）。息継ぎで切らないため。 */
  minSilence: number;
  /** 声の前後に残す余白（秒）。0 だと語頭・語尾が食われて不自然になる。 */
  padding: number;
  /** これより短くなった残し区間は捨てる（秒）。物音 1 発で 1 カットできるのを防ぐ。 */
  minKeep: number;
}

export const DEFAULT_JET_CUT: JetCutOptions = {
  thresholdDb: null,
  sensitivity: 0.25,
  minSilence: 0.35,
  padding: 0.08,
  minKeep: 0.15,
};

export interface JetCutPlan {
  /** 実際に使ったしきい値（自動決定の結果を見せるため）。 */
  thresholdDb: number;
  /** 残す区間。 */
  keep: Range[];
  /** 削る区間。 */
  cut: Range[];
  originalDuration: number;
  /** 削ったあとの尺。 */
  resultDuration: number;
  /** 削った秒数。 */
  removed: number;
}

/**
 * 音量の分布からしきい値を決める。
 * 下位 10% を「その素材の無音の底（部屋のノイズ）」、上位 10% を「声の大きさ」とみなし、
 * その間を sensitivity で内分する。録音レベルがバラバラな素材でも同じ感覚で効く。
 */
export function autoThresholdDb(track: LoudnessTrack, sensitivity: number): number {
  const floor = percentileDb(track, 0.1);
  const voice = percentileDb(track, 0.9);
  // ほぼ全編が同じ音量（無音だけ・BGM だけなど）のときは、分けようがないので底に張り付ける。
  if (voice - floor < 6) return floor - 1;
  const ratio = Math.max(0, Math.min(1, sensitivity));
  return floor + (voice - floor) * ratio;
}

/** 区間を繋いだり広げたりする小道具。start 昇順で重なりのない列を返す。 */
function mergeRanges(ranges: Range[], gap: number): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start - last.end <= gap) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/** keep の隙間を埋めるかたちで「削る区間」を作る。 */
function complement(keep: Range[], duration: number): Range[] {
  const cut: Range[] = [];
  let cursor = 0;
  for (const range of keep) {
    if (range.start > cursor) cut.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration) cut.push({ start: cursor, end: duration });
  return cut;
}

export function planJetCut(track: LoudnessTrack, options: Partial<JetCutOptions> = {}): JetCutPlan {
  const opts = { ...DEFAULT_JET_CUT, ...options };
  const thresholdDb = opts.thresholdDb ?? autoThresholdDb(track, opts.sensitivity);
  const duration = track.duration;

  // 2. しきい値を超えたコマを拾い、そのまま 3. の余白を足す。
  const loud: Range[] = [];
  for (let i = 0; i < track.db.length; i += 1) {
    if (track.db[i] <= thresholdDb || track.db[i] <= SILENCE_DB) continue;
    loud.push({
      start: Math.max(0, i * track.hop - opts.padding),
      end: Math.min(duration, (i + 1) * track.hop + opts.padding),
    });
  }

  // 3. 隣り合うものと、minSilence より短い切れ目しかないものを繋ぐ。
  const keep = mergeRanges(loud, opts.minSilence).filter((r) => r.end - r.start >= opts.minKeep);
  const cut = complement(keep, duration);

  const kept = keep.reduce((sum, r) => sum + (r.end - r.start), 0);
  return {
    thresholdDb,
    keep,
    cut,
    originalDuration: duration,
    resultDuration: kept,
    removed: Math.max(0, duration - kept),
  };
}
