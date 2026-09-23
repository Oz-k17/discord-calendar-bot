/**
 * 表紙を**どの形式で書き出すか**を決めるために測る。
 *
 * ## これは画面の一部ではない
 *
 * `index.html` からは読み込んでいない。`format-probe.mjs` が playwright 越しに
 * `<script type="module">` として差し込むためだけに置いてある（`encode.ts` と同じ立場）。
 *
 * ## なぜ測る所をブラウザに置くのか
 *
 * JPEG を焼く道具が Node には無い。外部ライブラリを足す話でもなくて、
 * **実際に書き出すのは `canvas.toBlob` なのだから、それで測るのがいちばん近い。**
 * ここで出した数字と、画面が本当に出す絵は、同じ符号化器から来る。
 *
 * ## 何を測るか（形式を決めるのに要るのはこの 3 つ）
 *
 * 1. **大きさ**（バイト）。表紙の行き先は容量に上限があることが多い。
 * 2. **選んだ理由が残っているか。** 表紙は「細かさ × 写り」で選んでいるので、
 *    書き出しで細かさが削られるなら、**選んだ根拠ごと消えている**ことになる。
 * 3. **文字帯の中と外で、壊れ方が違うか。** `export.ts` には
 *    「表紙は文字や線が乗る前提なので、非可逆では出さない」と書いてあるが、
 *    それは**測って決めたことではない**（9/23・2 回目に書いた思い込み）。
 *    帯の中と外を分けて測れば、その前提が本当かどうかが出る。
 *
 * 誤差は**明るさの二乗平均（0〜255）**で取る。画素をそのまま引き算するので、
 * 分布の距離（`combinedHistDistance`）と違って**位置がずれたことも数える**。
 * 形式の比較で見たいのは「同じ絵か」ではなく「どれくらい崩れたか」なので、こちらが要る。
 */

import { decodeVideoFrames } from '../../scene-cut/src/decode.ts';
import { summarizeFrames, combinedHistDistance } from '../../scene-cut/src/frames.ts';
import { summarizeThumb, summarizeThumbs, type FrameLike } from '../src/thumb.ts';
import { pickThumbnails } from '../src/pick.ts';
import { decodeFramesAt } from '../src/export.ts';
import { encodeThumbFixture } from './encode.ts';

/**
 * ここだけは `export.ts` を借りずに自前で焼く。
 *
 * 測っている時点では `export.ts` に PNG しか無いので、**借りる相手がまだ居ない。**
 * 実装したあとも残してあるのは、`export.ts` の側を直したときに
 * ここが道連れになると「実装を測っているのか、測り方を測っているのか」が
 * 分からなくなるため。**測る側は独立させておく。**
 */
function toBlob(frame: FrameLike, type: string, quality?: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`${type} で書き出せませんでした`))), type, quality);
  });
}

/** 書き出した絵を、**同じ大きさのまま**画素へ戻す（縮めない。縮めると誤差が均されて消える）。 */
async function readBack(blob: Blob, width: number, height: number): Promise<FrameLike> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

/**
 * 元のコマと書き出した絵の、明るさの食い違い（0〜255）。
 *
 * `band` に高さの割合の区間（上の帯・下の帯）を渡すと、**その中と外を分けて**返す。
 * 焼き込みの文字帯は平らな板の上に高い対比の文字が乗るので、
 * **非可逆の粗が出るならまずここ**に出る。全体の平均だけを見ていると、
 * 画面の 26% でしかない帯の中の荒れが、残り 74% に薄められて見えなくなる。
 */
function lumaError(
  a: FrameLike,
  b: FrameLike,
  bands: { from: number; to: number }[],
): { all: number; inBand: number; outBand: number; worstCell: number } {
  const { width, height } = a;
  const cellsX = 8;
  const cellsY = 8;
  const cellSum = new Float64Array(cellsX * cellsY);
  const cellCount = new Float64Array(cellsX * cellsY);
  let sumAll = 0;
  let sumIn = 0;
  let sumOut = 0;
  let nIn = 0;
  let nOut = 0;
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const inside = bands.some((r) => v >= r.from && v < r.to);
    const cy = Math.min(cellsY - 1, Math.floor(v * cellsY));
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const la = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
      const lb = 0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2];
      const d = (la - lb) * (la - lb);
      sumAll += d;
      if (inside) {
        sumIn += d;
        nIn += 1;
      } else {
        sumOut += d;
        nOut += 1;
      }
      const cx = Math.min(cellsX - 1, Math.floor(((x + 0.5) / width) * cellsX));
      cellSum[cy * cellsX + cx] += d;
      cellCount[cy * cellsX + cx] += 1;
    }
  }
  let worst = 0;
  for (let i = 0; i < cellSum.length; i += 1) {
    if (cellCount[i] === 0) continue;
    const rms = Math.sqrt(cellSum[i] / cellCount[i]);
    if (rms > worst) worst = rms;
  }
  const n = width * height;
  return {
    all: Math.sqrt(sumAll / Math.max(1, n)),
    inBand: nIn ? Math.sqrt(sumIn / nIn) : 0,
    outBand: nOut ? Math.sqrt(sumOut / nOut) : 0,
    worstCell: worst,
  };
}

export interface FormatSample {
  /** `png` か `jpeg q0.90` のような札。 */
  label: string;
  type: string;
  quality: number | null;
  bytes: number;
  /** 1000 画素あたりのバイト数。素材の大きさが違っても並べられる。 */
  bytesPerKilopixel: number;
  /** 元のコマとの明るさの食い違い（0〜255）。 */
  rmse: number;
  rmseInBand: number;
  rmseOutBand: number;
  worstCell: number;
  /** 書き出した絵の細かさ ÷ 元のコマの細かさ。**選んだ根拠が残っているか。** */
  gradRatio: number;
  /**
   * 元のコマの細かさそのもの。
   *
   * 比だけを見ていると読み違える。**分母が小さければ、同じ量の粗が大きな比になる。**
   * 素材は 128×72 を焼くときに引き伸ばしているので、倍率を上げるほど中身は滑らかになり、
   * 分母はそのぶん小さくなる。ここを並べておかないと、
   * 「JPEG が細かさを足した」のか「素材が滑らかすぎた」のかが区別できない。
   */
  gradBefore: number;
  /** 分布の隔たり（`uitest.mjs` の「同じ絵か」の検査と同じ物差し）。 */
  histDistance: number;
}

export interface FormatReport {
  fixture: string;
  width: number;
  height: number;
  /** 候補の秒。 */
  times: number[];
  /** 文字帯の区間（高さの割合）。無ければ空。 */
  bands: { from: number; to: number }[];
  /** 候補ごとの測定（候補 × 形式）。 */
  picks: FormatSample[][];
}

/**
 * 素材を焼いて読み込み、候補を選び、**その候補を形式ちがいで書き出して測る**。
 *
 * 選ぶ所までは画面とまったく同じ道（`decodeVideoFrames` → `summarizeThumbs` →
 * `pickThumbnails` → `decodeFramesAt`）を通す。形式の話だけを変えたいので、
 * ここで別の選び方をすると比べる相手が変わってしまう。
 */
export async function measureFormats(
  name: string,
  {
    aspect = 'landscape',
    qualities = [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 1],
    bands = [] as { from: number; to: number }[],
    scale = 4,
  } = {},
): Promise<FormatReport> {
  // 焼く倍率を上げると、**実寸の絵**（1920×1080）でそのまま測れる。
  // 小さい絵で測ってバイト数を掛け算すると、PNG も JPEG も画素あたりの効率が
  // 大きさで変わるので当てにならない（置き先の容量の上限を語るならここを動かす）。
  const encoded = await encodeThumbFixture(name, { aspect, scale });
  const file = new Blob([encoded.bytes], { type: 'video/webm' });
  const clip = await decodeVideoFrames(file);
  const stats = summarizeThumbs(clip.frames, clip.times);
  const frameStats = summarizeFrames(clip.frames, clip.times);
  const picks = pickThumbnails(stats, frameStats, {});
  // 書き出しの上限（長辺 1920）は既定のまま。実寸で焼いた素材はここで縮まない。
  const frames = await decodeFramesAt(file, picks.map((p) => p.time));

  const out: FormatSample[][] = [];
  for (const frame of frames) {
    if (!frame) {
      out.push([]);
      continue;
    }
    const before = summarizeThumb(frame, 0);
    const row: FormatSample[] = [];
    const variants: { label: string; type: string; quality: number | null }[] = [
      { label: 'png', type: 'image/png', quality: null },
      ...qualities.map((q) => ({ label: `jpeg q${q.toFixed(2)}`, type: 'image/jpeg', quality: q })),
    ];
    for (const v of variants) {
      const blob = await toBlob(frame, v.type, v.quality ?? undefined);
      const back = await readBack(blob, frame.width, frame.height);
      const after = summarizeThumb(back, 0);
      const err = lumaError(frame, back, bands);
      const pair = summarizeFrames([frame, back], [0, 1]);
      row.push({
        label: v.label,
        type: blob.type,
        quality: v.quality,
        bytes: blob.size,
        bytesPerKilopixel: (blob.size / (frame.width * frame.height)) * 1000,
        rmse: err.all,
        rmseInBand: err.inBand,
        rmseOutBand: err.outBand,
        worstCell: err.worstCell,
        gradRatio: before.grad > 0 ? after.grad / before.grad : 0,
        gradBefore: before.grad,
        histDistance: combinedHistDistance(pair[0], pair[1]),
      });
    }
    out.push(row);
  }

  return {
    fixture: name,
    width: frames.find((f) => f)?.width ?? 0,
    height: frames.find((f) => f)?.height ?? 0,
    times: picks.map((p) => p.time),
    bands,
    picks: out,
  };
}

declare global {
  interface Window {
    __labThumbFormats: typeof measureFormats;
  }
}
window.__labThumbFormats = measureFormats;
