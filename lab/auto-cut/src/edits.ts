/**
 * 計画（秒の並び）を、タイムラインの操作へ翻訳する。
 *
 * ここが「実験を本体へ持っていく」ときの継ぎ目になる。
 * 本体の Clip 型には依存させず、必要な 3 つの数字だけを受け取る形にしてある。
 */

import type { Range } from './silence.ts';

/** 対象クリップの、タイムライン上の位置と素材内の位置。 */
export interface ClipPlacement {
  /** タイムライン上の開始（秒）。 */
  start: number;
  /** 尺（秒）。 */
  duration: number;
  /** 素材のどこから使っているか（秒）。 */
  sourceIn: number;
  /** 再生速度。1 なら等速。 */
  speed?: number;
}

/** 分割後の 1 本。start は「隙間を詰めたあと」の位置。 */
export interface ClipEdit extends ClipPlacement {
  /** 元の音のどの区間から来たか（表示用）。 */
  from: Range;
}

/**
 * 計画をクリップの並びに変換する。
 *
 * plan の時刻は「素材の頭からの秒数」なので、
 *   タイムライン上の位置 = クリップの start + (素材内の位置 - sourceIn) / speed
 * で置き換えたうえで、削った隙間を前へ詰める（リップル削除と同じ）。
 */
export function toClipEdits(keep: Range[], clip: ClipPlacement): ClipEdit[] {
  const speed = Math.max(0.0625, clip.speed ?? 1);
  const sourceEnd = clip.sourceIn + clip.duration * speed;
  const edits: ClipEdit[] = [];
  let cursor = clip.start;

  for (const range of keep) {
    // クリップが使っている範囲の外は捨てる。
    const from = Math.max(clip.sourceIn, range.start);
    const to = Math.min(sourceEnd, range.end);
    if (to - from <= 0) continue;
    const duration = (to - from) / speed;
    edits.push({ start: cursor, duration, sourceIn: from, speed, from: { start: from, end: to } });
    cursor += duration;
  }

  return edits;
}

/** 見せる用のまとめ。 */
export function summarize(edits: ClipEdit[], clip: ClipPlacement) {
  const after = edits.reduce((sum, e) => sum + e.duration, 0);
  return {
    pieces: edits.length,
    before: clip.duration,
    after,
    removed: Math.max(0, clip.duration - after),
    ratio: clip.duration > 0 ? after / clip.duration : 1,
  };
}
